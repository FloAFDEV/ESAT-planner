-- ============================================================
-- AJOUTS STRUCTURELS : colonnes, vues, triggers
-- ============================================================

-- 1. Corriger tg_apply_mouvement pour traiter ADJUST comme IN
--    (les deux incrémentent le stock physique)
CREATE OR REPLACE FUNCTION public.tg_apply_mouvement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.type = 'OUT' THEN
    UPDATE public.composants SET stock = stock - NEW.quantity WHERE id = NEW.composant_id;
  ELSE
    -- IN et ADJUST incrémentent tous les deux
    UPDATE public.composants SET stock = stock + NEW.quantity WHERE id = NEW.composant_id;
  END IF;
  RETURN NEW;
END $$;

-- 2. Colonnes de traçabilité dans mouvements
ALTER TABLE public.mouvements
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id   uuid;

-- 3. Convertir stock_movements en VIEW (était une TABLE dans certains envs)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'stock_movements'
  ) THEN
    DROP TABLE public.stock_movements CASCADE;
  ELSIF EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'stock_movements'
  ) THEN
    DROP VIEW public.stock_movements CASCADE;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.stock_movements AS
SELECT
  id, composant_id, type, quantity,
  reason, production_order_id,
  source_type, source_id,
  created_at
FROM public.mouvements;

-- Recréer stock_by_composant si supprimée en cascade
CREATE OR REPLACE VIEW public.stock_by_composant AS
SELECT
  m.composant_id,
  COALESCE(SUM(
    CASE
      WHEN m.type::text IN ('IN','ADJUST') THEN  m.quantity
      WHEN m.type::text = 'OUT'            THEN -m.quantity
      ELSE 0
    END
  ), 0)::bigint AS total_stock
FROM public.mouvements m
GROUP BY m.composant_id;

-- 4. is_active sur nomenclatures (désactiver une ligne BOM sans la supprimer)
ALTER TABLE public.nomenclatures
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_nomenclatures_coffret_active
  ON public.nomenclatures(coffret_id) WHERE is_active = true;

-- 5. Suivi de production partielle sur production_orders
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS produced_qty  integer    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS validated_at  timestamptz;

-- 6. Stock de produits finis sur coffrets
ALTER TABLE public.coffrets
  ADD COLUMN IF NOT EXISTS stock_fini integer NOT NULL DEFAULT 0;

-- 7. Dédupliquer les triggers sur stock_reservations
--    tg_apply_stock_reservations (20260423_atelier_mode_refactor) +
--    tg_sync_reserved_stock (20260423_production_order_safe_rpc)
--    coexistaient → double mise à jour de reserved_stock.
--    On supprime le premier et on réécrit le second proprement.
DROP TRIGGER IF EXISTS tg_apply_stock_reservations ON public.stock_reservations;

-- 8. Réécriture du trigger de synchronisation reserved_stock
--    Ne compte que les réservations actives avec quantité > 0.
CREATE OR REPLACE FUNCTION public.tg_sync_reserved_stock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[];
BEGIN
  CASE TG_OP
    WHEN 'INSERT' THEN v_ids := ARRAY[NEW.composant_id];
    WHEN 'DELETE' THEN v_ids := ARRAY[OLD.composant_id];
    ELSE               v_ids := ARRAY[OLD.composant_id, NEW.composant_id];
  END CASE;

  WITH totals AS (
    SELECT composant_id,
           COALESCE(SUM(quantity), 0)::integer AS total_reserved
    FROM public.stock_reservations
    WHERE status = 'active'
      AND quantity > 0
      AND composant_id = ANY(v_ids)
    GROUP BY composant_id
  )
  UPDATE public.composants c
  SET reserved_stock = COALESCE(t.total_reserved, 0)
  FROM (SELECT DISTINCT unnest(v_ids) AS composant_id) a
  LEFT JOIN totals t USING (composant_id)
  WHERE c.id = a.composant_id;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS tg_sync_reserved_stock ON public.stock_reservations;
CREATE TRIGGER tg_sync_reserved_stock
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_sync_reserved_stock();
