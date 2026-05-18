-- RPC atomique: création d'un ordre de production + consommations + mouvements stock.
-- Toute erreur lève une exception PostgreSQL et annule l'ensemble des écritures.

CREATE OR REPLACE FUNCTION public.create_production_order_atomic(
  p_coffret_id uuid,
  p_quantity integer,
  p_status public.production_status DEFAULT 'draft'::public.production_status,
  p_priority integer DEFAULT 0,
  p_notes text DEFAULT NULL
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.coffrets c
    WHERE c.id = p_coffret_id
  ) THEN
    RAISE EXCEPTION 'coffret not found: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.coffret_components cc
    WHERE cc.coffret_id = p_coffret_id
  ) THEN
    RAISE EXCEPTION 'no coffret_components found for coffret %', p_coffret_id;
  END IF;

  -- Verrouille les composants du coffret pour limiter les courses critiques.
  PERFORM 1
  FROM public.composants c
  JOIN public.coffret_components cc ON cc.composant_id = c.id
  WHERE cc.coffret_id = p_coffret_id
  FOR UPDATE;

  -- Vérification de stock depuis stock_movements uniquement: SUM(IN + ADJUST - OUT).
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

  -- 1) production_orders
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

  -- 2) production_consumption
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

  -- 3) stock_movements (OUT)
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

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'reference', v_reference,
    'coffret_id', p_coffret_id,
    'quantity', p_quantity,
    'status', p_status,
    'priority', p_priority
  );
END;
$$;