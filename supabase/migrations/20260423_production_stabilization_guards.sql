-- Stabilisation production: idempotence, intégrité stock, performance et audit.

-- 1) Idempotence pour create_production_order_atomic
CREATE TABLE IF NOT EXISTS public.production_order_idempotency (
  idempotency_key text PRIMARY KEY,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_order_idempotency_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.production_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_production_order_idempotency_order_id
  ON public.production_order_idempotency(order_id);

-- 2) Performance stock_movements
CREATE INDEX IF NOT EXISTS idx_stock_movements_composant_id
  ON public.stock_movements(composant_id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_type
  ON public.stock_movements(type);

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at
  ON public.stock_movements(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_composant_type_created
  ON public.stock_movements(composant_id, type, created_at DESC);

-- 3) Garde-fou stock négatif via trigger léger
CREATE OR REPLACE FUNCTION public.tg_stock_movements_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current integer;
  v_projected integer;
  v_current_old integer;
  v_projected_old integer;
  v_delta_old integer;
  v_delta_new integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
      RAISE EXCEPTION 'stock_movements.quantity must be > 0';
    END IF;

    SELECT COALESCE(SUM(CASE
      WHEN type IN ('IN', 'ADJUST') THEN quantity
      WHEN type = 'OUT' THEN -quantity
      ELSE 0
    END), 0)
    INTO v_current
    FROM public.stock_movements
    WHERE composant_id = NEW.composant_id;

    v_delta_new := CASE WHEN NEW.type = 'OUT' THEN -NEW.quantity ELSE NEW.quantity END;
    v_projected := v_current + v_delta_new;

    IF v_projected < 0 THEN
      RAISE EXCEPTION 'stock cannot become negative for composant % (projected %)', NEW.composant_id, v_projected;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
      RAISE EXCEPTION 'stock_movements.quantity must be > 0';
    END IF;

    v_delta_old := CASE WHEN OLD.type = 'OUT' THEN -OLD.quantity ELSE OLD.quantity END;
    v_delta_new := CASE WHEN NEW.type = 'OUT' THEN -NEW.quantity ELSE NEW.quantity END;

    IF NEW.composant_id = OLD.composant_id THEN
      SELECT COALESCE(SUM(CASE
        WHEN type IN ('IN', 'ADJUST') THEN quantity
        WHEN type = 'OUT' THEN -quantity
        ELSE 0
      END), 0)
      INTO v_current
      FROM public.stock_movements
      WHERE composant_id = NEW.composant_id;

      v_projected := v_current - v_delta_old + v_delta_new;
      IF v_projected < 0 THEN
        RAISE EXCEPTION 'stock cannot become negative for composant % (projected %)', NEW.composant_id, v_projected;
      END IF;
    ELSE
      SELECT COALESCE(SUM(CASE
        WHEN type IN ('IN', 'ADJUST') THEN quantity
        WHEN type = 'OUT' THEN -quantity
        ELSE 0
      END), 0)
      INTO v_current_old
      FROM public.stock_movements
      WHERE composant_id = OLD.composant_id;

      v_projected_old := v_current_old - v_delta_old;
      IF v_projected_old < 0 THEN
        RAISE EXCEPTION 'stock cannot become negative for composant % (projected %)', OLD.composant_id, v_projected_old;
      END IF;

      SELECT COALESCE(SUM(CASE
        WHEN type IN ('IN', 'ADJUST') THEN quantity
        WHEN type = 'OUT' THEN -quantity
        ELSE 0
      END), 0)
      INTO v_current
      FROM public.stock_movements
      WHERE composant_id = NEW.composant_id;

      v_projected := v_current + v_delta_new;
      IF v_projected < 0 THEN
        RAISE EXCEPTION 'stock cannot become negative for composant % (projected %)', NEW.composant_id, v_projected;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_delta_old := CASE WHEN OLD.type = 'OUT' THEN -OLD.quantity ELSE OLD.quantity END;

    SELECT COALESCE(SUM(CASE
      WHEN type IN ('IN', 'ADJUST') THEN quantity
      WHEN type = 'OUT' THEN -quantity
      ELSE 0
    END), 0)
    INTO v_current
    FROM public.stock_movements
    WHERE composant_id = OLD.composant_id;

    v_projected := v_current - v_delta_old;
    IF v_projected < 0 THEN
      RAISE EXCEPTION 'stock cannot become negative for composant % (projected %)', OLD.composant_id, v_projected;
    END IF;

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_movements_guard ON public.stock_movements;
CREATE TRIGGER trg_stock_movements_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.tg_stock_movements_guard();

-- 4) RPC atomique renforcée (idempotence)
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

  IF p_status IS NULL THEN
    RAISE EXCEPTION 'p_status is required';
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  INSERT INTO public.production_order_idempotency (idempotency_key, order_id)
  VALUES (p_idempotency_key, NULL)
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT po.id, po.reference
    INTO v_order_id, v_reference
    FROM public.production_order_idempotency poi
    JOIN public.production_orders po ON po.id = poi.order_id
    WHERE poi.idempotency_key = p_idempotency_key;

    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'order_id', v_order_id,
        'reference', v_reference,
        'idempotent_replay', true
      );
    END IF;

    RAISE EXCEPTION 'idempotency key is already being processed: %', p_idempotency_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets c WHERE c.id = p_coffret_id
  ) THEN
    RAISE EXCEPTION 'coffret not found: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.coffret_components cc WHERE cc.coffret_id = p_coffret_id
  ) THEN
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
    'OUT',
    (cc.quantity * p_quantity)::integer,
    'production_order',
    v_order_id
  FROM public.coffret_components cc
  WHERE cc.coffret_id = p_coffret_id;

  UPDATE public.production_order_idempotency
  SET order_id = v_order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'reference', v_reference,
    'coffret_id', p_coffret_id,
    'quantity', p_quantity,
    'status', p_status,
    'priority', p_priority,
    'idempotent_replay', false
  );
END;
$$;

-- 5) Requête d'audit: détection incohérences et dérives
CREATE OR REPLACE VIEW public.v_stock_integrity_audit AS
WITH stock_by_component AS (
  SELECT
    sm.composant_id,
    COALESCE(SUM(CASE WHEN sm.type IN ('IN', 'ADJUST') THEN sm.quantity ELSE 0 END), 0)::integer AS total_in_adjust,
    COALESCE(SUM(CASE WHEN sm.type = 'OUT' THEN sm.quantity ELSE 0 END), 0)::integer AS total_out,
    COALESCE(SUM(CASE
      WHEN sm.type IN ('IN', 'ADJUST') THEN sm.quantity
      WHEN sm.type = 'OUT' THEN -sm.quantity
      ELSE 0
    END), 0)::integer AS stock_calc,
    COUNT(*)::integer AS movement_count,
    MAX(sm.created_at) AS last_movement_at
  FROM public.stock_movements sm
  GROUP BY sm.composant_id
)
SELECT
  'NEGATIVE_STOCK'::text AS anomaly_type,
  s.composant_id,
  jsonb_build_object(
    'stock_calc', s.stock_calc,
    'total_in_adjust', s.total_in_adjust,
    'total_out', s.total_out,
    'movement_count', s.movement_count,
    'last_movement_at', s.last_movement_at
  ) AS details
FROM stock_by_component s
WHERE s.stock_calc < 0

UNION ALL

SELECT
  'INVALID_QUANTITY'::text AS anomaly_type,
  sm.composant_id,
  jsonb_build_object(
    'movement_id', sm.id,
    'type', sm.type,
    'quantity', sm.quantity,
    'created_at', sm.created_at
  ) AS details
FROM public.stock_movements sm
WHERE sm.quantity <= 0

UNION ALL

SELECT
  'MISSING_COMPONENT_ID'::text AS anomaly_type,
  sm.composant_id,
  jsonb_build_object(
    'movement_id', sm.id,
    'type', sm.type,
    'quantity', sm.quantity,
    'created_at', sm.created_at
  ) AS details
FROM public.stock_movements sm
WHERE sm.composant_id IS NULL;
