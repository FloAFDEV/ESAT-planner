-- ============================================================
-- MIGRATION: Refonte atelier industriel simple
-- - Statuts production/livraison normalisés
-- - Priorité séparée de l'état
-- - RPCs de transition côté backend
-- - Stock réservé basé sur reservations réelles
-- ============================================================

-- ============ 1. PRODUCTION: statuts + priorité ==========
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'brouillon';
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'pret';
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'en_cours';
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'en_pause';
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'termine';
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'annule';

UPDATE public.production_orders
SET
  priority = CASE WHEN status::text = 'priority' THEN 1 ELSE priority END,
  status = CASE status::text
    WHEN 'draft' THEN 'brouillon'::public.production_status
    WHEN 'in_progress' THEN 'en_cours'::public.production_status
    WHEN 'done' THEN 'termine'::public.production_status
    WHEN 'priority' THEN 'en_cours'::public.production_status
    ELSE status
  END;

ALTER TABLE public.production_orders
  ALTER COLUMN status SET DEFAULT 'brouillon';

-- ============ 2. LIVRAISONS: statut simple ==========
ALTER TABLE public.livraisons
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'brouillon';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'livraisons_status_check'
      AND conrelid = 'public.livraisons'::regclass
  ) THEN
    ALTER TABLE public.livraisons DROP CONSTRAINT livraisons_status_check;
  END IF;
END $$;

ALTER TABLE public.livraisons
  ADD CONSTRAINT livraisons_status_check
  CHECK (status IN ('brouillon', 'pret', 'expedie', 'livre', 'annule'));

UPDATE public.livraisons
SET status = CASE status
  WHEN 'draft' THEN 'brouillon'
  WHEN 'prepared' THEN 'pret'
  WHEN 'loaded' THEN 'expedie'
  WHEN 'delivered' THEN 'livre'
  WHEN 'cancelled' THEN 'annule'
  WHEN 'canceled' THEN 'annule'
  ELSE status
END;

-- ============ 3. STOCK: recalcul des réservations ==========
CREATE OR REPLACE FUNCTION public.tg_apply_stock_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.composants c
  SET reserved_stock = COALESCE(agg.total_reserved, 0)
  FROM (
    SELECT
      composant_id,
      SUM(quantity) AS total_reserved
    FROM public.stock_reservations
    WHERE status = 'active'
    GROUP BY composant_id
  ) agg
  WHERE c.id = COALESCE(NEW.composant_id, OLD.composant_id)
    AND agg.composant_id = c.id;

  UPDATE public.composants c
  SET reserved_stock = 0
  WHERE c.id = COALESCE(NEW.composant_id, OLD.composant_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.stock_reservations sr
      WHERE sr.composant_id = c.id
        AND sr.status = 'active'
    );

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS tg_apply_stock_reservations ON public.stock_reservations;
CREATE TRIGGER tg_apply_stock_reservations
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION public.tg_apply_stock_reservations();

-- ============ 4. RPC: transition production ==========
CREATE OR REPLACE FUNCTION public.transition_production_order_status(
  p_order_id uuid,
  p_status text,
  p_priority integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF v_order.status::text IN ('termine', 'annule') AND v_order.status::text <> p_status THEN
    RETURN jsonb_build_object('success', false, 'error', 'order is closed');
  END IF;

  IF p_status NOT IN ('brouillon', 'pret', 'en_cours', 'en_pause', 'annule') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status');
  END IF;

  UPDATE public.production_orders
  SET
    status = p_status::public.production_status,
    priority = COALESCE(p_priority, priority)
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id, 'status', p_status, 'priority', COALESCE(p_priority, v_order.priority));
END $$;

-- ============ 5. RPC: transition livraison ==========
CREATE OR REPLACE FUNCTION public.transition_livraison_status(
  p_livraison_id uuid,
  p_status text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_livraison public.livraisons%ROWTYPE;
BEGIN
  SELECT * INTO v_livraison
  FROM public.livraisons
  WHERE id = p_livraison_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'livraison not found');
  END IF;

  IF p_status NOT IN ('brouillon', 'pret', 'expedie', 'livre', 'annule') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status');
  END IF;

  IF v_livraison.status = 'livre' AND p_status <> 'annule' THEN
    RETURN jsonb_build_object('success', false, 'error', 'livraison already delivered');
  END IF;

  UPDATE public.livraisons
  SET status = p_status
  WHERE id = p_livraison_id;

  RETURN jsonb_build_object('success', true, 'livraison_id', p_livraison_id, 'status', p_status);
END $$;

-- ============ 6. RPC: production validation ==========
CREATE OR REPLACE FUNCTION public.validate_production_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  v_sim jsonb;
  r record;
BEGIN
  SELECT * INTO v_order FROM public.production_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'order not found'); END IF;
  IF v_order.status::text = 'termine' THEN RETURN jsonb_build_object('success', false, 'error', 'already done'); END IF;
  IF v_order.status::text = 'annule' THEN RETURN jsonb_build_object('success', false, 'error', 'order canceled'); END IF;

  v_sim := public.simulate_production(v_order.coffret_id, v_order.quantity);
  IF NOT (v_sim->>'fabricable')::boolean THEN
    RETURN jsonb_build_object('success', false, 'error', 'composants insuffisants', 'simulation', v_sim);
  END IF;

  FOR r IN
    SELECT n.composant_id, (n.quantity * v_order.quantity) AS qty
    FROM public.nomenclatures n WHERE n.coffret_id = v_order.coffret_id
  LOOP
    INSERT INTO public.mouvements(composant_id, type, quantity, reason, production_order_id)
    VALUES (r.composant_id, 'OUT', r.qty, 'Production ' || v_order.reference, v_order.id);
  END LOOP;

  UPDATE public.production_orders
  SET status = 'termine', done_at = now()
  WHERE id = v_order.id;

  RETURN jsonb_build_object('success', true, 'order_id', v_order.id);
END $$;

-- ============ 7. RPC: annulation production ==========
CREATE OR REPLACE FUNCTION public.cancel_production_order_with_unreserve(
  p_order_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.production_orders
  WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF v_order.status::text = 'termine' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot cancel completed order');
  END IF;

  UPDATE public.stock_reservations
  SET status = 'canceled'
  WHERE production_order_id = p_order_id AND status = 'active';

  UPDATE public.production_orders
  SET status = 'annule'
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id);
END $$;

-- ============ 8. RPC: simulate production sur stock réel ==========
CREATE OR REPLACE FUNCTION public.simulate_production(p_coffret_id uuid, p_quantity integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_coffret public.coffrets%ROWTYPE;
  v_missing jsonb := '[]'::jsonb;
  v_remaining jsonb := '[]'::jsonb;
  v_fabricable boolean := true;
  v_palettes numeric;
  v_poids numeric;
  r record;
BEGIN
  SELECT * INTO v_coffret FROM public.coffrets WHERE id = p_coffret_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'coffret not found');
  END IF;

  FOR r IN
    SELECT
      c.id, c.reference, c.name, c.stock, c.reserved_stock,
      n.quantity AS per_unit,
      (n.quantity * p_quantity) AS needed
    FROM public.nomenclatures n
    JOIN public.composants c ON c.id = n.composant_id
    WHERE n.coffret_id = p_coffret_id
  LOOP
    DECLARE
      v_dispo integer := r.stock - COALESCE(r.reserved_stock, 0);
      v_after integer := v_dispo - r.needed;
    BEGIN
      IF v_after < 0 THEN
        v_fabricable := false;
        v_missing := v_missing || jsonb_build_object(
          'composant_id', r.id, 'reference', r.reference, 'name', r.name,
          'needed', r.needed, 'available', v_dispo, 'manquant', -v_after
        );
      END IF;
      v_remaining := v_remaining || jsonb_build_object(
        'composant_id', r.id, 'reference', r.reference, 'name', r.name,
        'stock_actuel', r.stock, 'reserve', COALESCE(r.reserved_stock, 0), 'apres_production', v_after
      );
    END;
  END LOOP;

  v_palettes := CEIL(p_quantity::numeric / GREATEST(v_coffret.nb_par_palette, 1));
  v_poids := p_quantity * v_coffret.poids_coffret;

  RETURN jsonb_build_object(
    'fabricable', v_fabricable,
    'coffret', jsonb_build_object('id', v_coffret.id, 'reference', v_coffret.reference, 'name', v_coffret.name),
    'quantity', p_quantity,
    'composants_manquants', v_missing,
    'stock_restant', v_remaining,
    'palettes', v_palettes,
    'poids_total', v_poids
  );
END $$;

-- ============ 9. STOCK: vue de lecture ==========
CREATE OR REPLACE VIEW public.stock_movements AS
SELECT
  id,
  composant_id,
  type,
  quantity,
  reason,
  production_order_id,
  created_at
FROM public.mouvements;

-- ============ 10. RPC: enregistrement d'un mouvement stock ==========
CREATE OR REPLACE FUNCTION public.record_stock_movement(
  p_composant_id uuid,
  p_type public.mouvement_type,
  p_quantity integer,
  p_reason text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_reference_id text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mouvement_id uuid;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'quantity must be > 0');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.composants WHERE id = p_composant_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'component not found');
  END IF;

  INSERT INTO public.mouvements (
    composant_id, type, quantity, reason, production_order_id
  )
  VALUES (
    p_composant_id,
    p_type,
    p_quantity,
    COALESCE(p_reason, p_entity_type || COALESCE(':' || p_reference_id, '')),
    NULL
  )
  RETURNING id INTO v_mouvement_id;

  RETURN jsonb_build_object('success', true, 'movement_id', v_mouvement_id);
END $$;

COMMIT;