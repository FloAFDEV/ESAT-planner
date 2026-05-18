-- ============================================================
-- MIGRATION: Production statuts — Source unique CANONIQUE
-- Supprime TOUTE conversion legacy → canonical
-- DB = UI = API : une seule nomenclature
-- ============================================================

-- ============ 1. CONVERSION DATA: legacy → canonical ============
-- Retour aux statuts canoniques uniquement
UPDATE public.production_orders
SET status = CASE status::text
  WHEN 'brouillon' THEN 'draft'::public.production_status
  WHEN 'pret' THEN 'draft'::public.production_status
  WHEN 'en_cours' THEN 'in_progress'::public.production_status
  WHEN 'en_pause' THEN 'in_progress'::public.production_status
  WHEN 'termine' THEN 'done'::public.production_status
  WHEN 'annule' THEN 'done'::public.production_status
  ELSE status
END;

ALTER TABLE public.production_orders
  ALTER COLUMN status SET DEFAULT 'draft';

-- ============ 2. RPC: transition production — CANONICAL UNIQUEMENT ============
-- Accepte SEULEMENT: draft, in_progress, done, priority
-- Pas de conversion interne
CREATE OR REPLACE FUNCTION public.transition_production_order_status(
  p_order_id uuid,
  p_status text,
  p_priority integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  v_canonical_status public.production_status;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Valide SEULEMENT les statuts canoniques
  IF p_status NOT IN ('draft', 'in_progress', 'done', 'priority') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status (must be draft, in_progress, done, or priority)');
  END IF;

  -- Bloque transition depuis done/priority vers autres états
  IF v_order.status::text IN ('done', 'priority') AND p_status NOT IN ('done', 'priority') THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot revert from terminal status');
  END IF;

  v_canonical_status := p_status::public.production_status;

  UPDATE public.production_orders
  SET
    status = v_canonical_status,
    priority = COALESCE(p_priority, priority),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'status', p_status,
    'priority', COALESCE(p_priority, v_order.priority)
  );
END $$;

-- ============ 3. RPC: validate production — Marquer comme DONE ============
-- Pas de conversion interne, utilise canonical uniquement
CREATE OR REPLACE FUNCTION public.validate_production_order(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.production_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF v_order.status::text = 'done' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already done');
  END IF;

  UPDATE public.production_orders
  SET
    status = 'done'::public.production_status,
    done_at = now(),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', p_order_id,
    'status', 'done'
  );
END $$;

-- ============ 4. RPC: create production — CANONICAL UNIQUEMENT ============
-- Accepte uniquement draft et priority
CREATE OR REPLACE FUNCTION public.create_production_order_atomic(
  p_coffret_id uuid,
  p_quantity integer,
  p_status public.production_status DEFAULT 'draft'::public.production_status,
  p_priority integer DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_reference text;
  v_available integer;
  v_need record;
  v_inserted integer;
BEGIN
  IF p_coffret_id IS NULL THEN
    RAISE EXCEPTION 'p_coffret_id is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'p_quantity must be > 0';
  END IF;

  IF p_priority IS NULL OR p_priority NOT IN (0, 1) THEN
    RAISE EXCEPTION 'p_priority must be 0 or 1';
  END IF;

  -- Valide SEULEMENT canonical: draft or priority (in_progress/done invalid at creation)
  IF p_status NOT IN ('draft'::public.production_status, 'priority'::public.production_status) THEN
    RAISE EXCEPTION 'invalid initial status (must be draft or priority)';
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  INSERT INTO public.production_order_idempotency (idempotency_key, order_id)
  VALUES (p_idempotency_key, NULL)
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT poi.order_id, po.reference
    INTO v_order_id, v_reference
    FROM public.production_order_idempotency poi
    LEFT JOIN public.production_orders po ON po.id = poi.order_id
    WHERE poi.idempotency_key = p_idempotency_key;

    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'order_id', v_order_id,
        'reference', v_reference,
        'idempotent_replay', true
      );
    END IF;

    RAISE EXCEPTION 'idempotency key conflict: %', p_idempotency_key;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.coffrets c WHERE c.id = p_coffret_id) THEN
    RAISE EXCEPTION 'coffret not found: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.coffret_components cc WHERE cc.coffret_id = p_coffret_id) THEN
    RAISE EXCEPTION 'no coffret_components found for coffret %', p_coffret_id;
  END IF;

  PERFORM 1
  FROM public.composants c
  JOIN public.coffret_components cc ON cc.composant_id = c.id
  WHERE cc.coffret_id = p_coffret_id
  FOR UPDATE;

  FOR v_need IN
    SELECT
      cc.composant_id,
      (cc.quantity * p_quantity)::integer AS qty_needed
    FROM public.coffret_components cc
    WHERE cc.coffret_id = p_coffret_id
  LOOP
    SELECT COALESCE(
      SUM(
        CASE
          WHEN sm.type IN ('IN', 'ADJUST') THEN sm.quantity
          WHEN sm.type = 'OUT' THEN -sm.quantity
          ELSE 0
        END
      ),
      0
    )::integer
    INTO v_available
    FROM public.stock_movements sm
    WHERE sm.composant_id = v_need.composant_id;

    IF v_available < v_need.qty_needed THEN
      RAISE EXCEPTION
        'insufficient stock for composant % (needed %, available %)',
        v_need.composant_id,
        v_need.qty_needed,
        v_available;
    END IF;
  END LOOP;

  INSERT INTO public.production_orders (
    coffret_id,
    quantity,
    status,
    priority,
    notes
  )
  VALUES (
    p_coffret_id,
    p_quantity,
    p_status,
    p_priority,
    p_notes
  )
  RETURNING id, reference
  INTO v_order_id, v_reference;

  INSERT INTO public.production_consumption (
    production_order_id,
    composant_id,
    quantity
  )
  SELECT
    v_order_id,
    cc.composant_id,
    (cc.quantity * p_quantity)::integer
  FROM public.coffret_components cc
  WHERE cc.coffret_id = p_coffret_id;

  INSERT INTO public.stock_movements (
    composant_id,
    type,
    quantity,
    source_type,
    source_id
  )
  SELECT
    cc.composant_id,
    'OUT'::text,
    (cc.quantity * p_quantity)::integer,
    'production_order'::text,
    v_order_id
  FROM public.coffret_components cc
  WHERE cc.coffret_id = p_coffret_id;

  UPDATE public.production_order_idempotency
  SET order_id = v_order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'reference', v_reference
  );
END $$;

COMMIT;
