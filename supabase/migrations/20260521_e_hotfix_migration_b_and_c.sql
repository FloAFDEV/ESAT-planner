-- ============================================================
-- HOTFIX : correction des migrations B et C
--
-- Problèmes corrigés :
--   1. Migration B échouait sur "stock_movements is not a view"
--      → stock_movements est une TABLE dans ce DB, pas une VIEW.
--      On gère les deux cas proprement avec un bloc DO conditionnel.
--   2. Steps 4-8 de la migration B non exécutés (arrêt au step 3).
--      → is_active sur nomenclatures, produced_qty/validated_at sur
--        production_orders, stock_fini sur coffrets, triggers.
--   3. validate_production_order avait deux surcharges (1 et 2 params)
--      → CREATE OR REPLACE avec signature différente crée une NOUVELLE
--        surcharge. Résultat : ambiguïté "function name is not unique".
--      On DROP les deux versions avant de recréer l'unique 2-params.
-- ============================================================


-- ═══════════════════════════════════════════════════════════
-- 1. stock_movements : TABLE → VIEW
--    Détecte le type actuel et gère les deux cas.
--    Les données historiques sont dans mouvements (trigger) ;
--    stock_movements TABLE est la table legacy.
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'stock_movements'
  ) THEN
    -- C'est une TABLE : la supprimer (données dans mouvements via trigger)
    DROP TABLE public.stock_movements CASCADE;
  ELSIF EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public' AND viewname = 'stock_movements'
  ) THEN
    DROP VIEW public.stock_movements CASCADE;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.stock_movements AS
SELECT
  id,
  composant_id,
  type,
  quantity,
  reason,
  production_order_id,
  source_type,
  source_id,
  created_at
FROM public.mouvements;

-- Recréer stock_by_composant si elle a été supprimée en cascade
CREATE OR REPLACE VIEW public.stock_by_composant AS
SELECT
  m.composant_id,
  COALESCE(
    SUM(
      CASE
        WHEN m.type::text IN ('IN', 'ADJUST') THEN  m.quantity
        WHEN m.type::text = 'OUT'             THEN -m.quantity
        ELSE 0
      END
    ),
    0
  )::bigint AS total_stock
FROM public.mouvements m
GROUP BY m.composant_id;


-- ═══════════════════════════════════════════════════════════
-- 2. Colonnes manquantes (steps 4-8 de la migration B)
-- ═══════════════════════════════════════════════════════════

-- is_active sur nomenclatures
ALTER TABLE public.nomenclatures
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_nomenclatures_coffret_active
  ON public.nomenclatures(coffret_id) WHERE is_active = true;

-- Suivi de production partielle
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS produced_qty  integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS validated_at  timestamptz;

-- Stock produits finis
ALTER TABLE public.coffrets
  ADD COLUMN IF NOT EXISTS stock_fini integer NOT NULL DEFAULT 0;

-- Supprimer le trigger dupliqué (créé par 20260423_atelier_mode_refactor)
DROP TRIGGER IF EXISTS tg_apply_stock_reservations ON public.stock_reservations;

-- Réécrire tg_sync_reserved_stock : ne compte que active + quantity > 0
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


-- ═══════════════════════════════════════════════════════════
-- 3. Corriger la surcharge de validate_production_order
--    DROP les deux variantes avant de recréer la version 2-params.
-- ═══════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.validate_production_order(uuid);
DROP FUNCTION IF EXISTS public.validate_production_order(uuid, integer);

CREATE OR REPLACE FUNCTION public.validate_production_order(
  p_order_id uuid,
  p_qty      integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order         public.production_orders%ROWTYPE;
  v_validate_qty  integer;
  v_remaining     integer;
  r               record;
  v_final_status  public.production_status;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF v_order.status::text = 'done' THEN
    RETURN jsonb_build_object(
      'success', true, 'order_id', p_order_id,
      'status', 'done', 'idempotent_replay', true
    );
  END IF;

  IF v_order.status::text IN ('canceled', 'annule') THEN
    RETURN jsonb_build_object('success', false, 'error', 'order is canceled');
  END IF;

  v_remaining := v_order.quantity - v_order.produced_qty;
  IF v_remaining <= 0 THEN
    UPDATE public.production_orders
    SET status = 'done'::public.production_status,
        done_at = COALESCE(done_at, now()),
        updated_at = now()
    WHERE id = p_order_id;
    RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'status', 'done');
  END IF;

  v_validate_qty := COALESCE(p_qty, v_remaining);

  IF v_validate_qty <= 0 THEN
    RAISE EXCEPTION 'validate quantity must be > 0';
  END IF;
  IF v_validate_qty > v_remaining THEN
    RAISE EXCEPTION
      'validate quantity (%) exceeds remaining (%) for order %',
      v_validate_qty, v_remaining, p_order_id;
  END IF;

  FOR r IN
    SELECT
      n.composant_id,
      (n.quantity * v_validate_qty)::integer AS qty
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id
      AND n.is_active = true
  LOOP
    INSERT INTO public.mouvements (
      composant_id, type, quantity, reason, production_order_id
    )
    VALUES (
      r.composant_id,
      'OUT',
      r.qty,
      'Production ' || v_order.reference ||
        CASE WHEN v_validate_qty < v_remaining
             THEN ' (partiel ' || (v_order.produced_qty + v_validate_qty)
                  || '/' || v_order.quantity || ')'
             ELSE ''
        END,
      v_order.id
    );
  END LOOP;

  UPDATE public.stock_reservations sr
  SET status = 'consumed', updated_at = now()
  FROM public.nomenclatures n
  WHERE sr.production_order_id = p_order_id
    AND sr.composant_id = n.composant_id
    AND n.coffret_id = v_order.coffret_id
    AND sr.status = 'active'
    AND sr.quantity <= (n.quantity * v_validate_qty);

  UPDATE public.stock_reservations sr
  SET quantity = sr.quantity - (n.quantity * v_validate_qty),
      updated_at = now()
  FROM public.nomenclatures n
  WHERE sr.production_order_id = p_order_id
    AND sr.composant_id = n.composant_id
    AND n.coffret_id = v_order.coffret_id
    AND sr.status = 'active'
    AND sr.quantity > (n.quantity * v_validate_qty);

  UPDATE public.coffrets
  SET stock_fini = stock_fini + v_validate_qty
  WHERE id = v_order.coffret_id;

  v_final_status := CASE
    WHEN v_order.produced_qty + v_validate_qty >= v_order.quantity
      THEN 'done'::public.production_status
    ELSE 'partial'::public.production_status
  END;

  UPDATE public.production_orders
  SET
    produced_qty  = produced_qty + v_validate_qty,
    status        = v_final_status,
    done_at       = CASE WHEN v_final_status = 'done' THEN now() ELSE done_at END,
    validated_at  = COALESCE(validated_at, now()),
    updated_at    = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',       true,
    'order_id',      p_order_id,
    'validated_qty', v_validate_qty,
    'produced_qty',  v_order.produced_qty + v_validate_qty,
    'total_qty',     v_order.quantity,
    'status',        v_final_status::text
  );
END;
$$;
