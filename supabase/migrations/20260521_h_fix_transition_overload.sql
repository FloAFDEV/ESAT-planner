-- ============================================================
-- HOTFIX H : surcharge transition_production_order_status
--
-- CREATE OR REPLACE avec p_priority DEFAULT NULL a créé une
-- DEUXIÈME surcharge à côté de l'ancienne version 2-params.
-- → "Could not choose the best candidate function"
--
-- Solution : DROP les deux variantes, recréer uniquement la 3-params.
-- Même pattern que le fix validate_production_order dans migration E.
-- ============================================================

DROP FUNCTION IF EXISTS public.transition_production_order_status(uuid, text);
DROP FUNCTION IF EXISTS public.transition_production_order_status(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.transition_production_order_status(
  p_order_id uuid,
  p_status   text,
  p_priority integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order     public.production_orders%ROWTYPE;
  v_canonical public.production_status;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF p_status NOT IN ('draft', 'priority', 'in_progress', 'partial', 'done') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid status (allowed: draft, priority, in_progress, partial, done)'
    );
  END IF;

  IF v_order.status::text IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot transition from terminal status ' || v_order.status::text
    );
  END IF;

  v_canonical := p_status::public.production_status;

  UPDATE public.production_orders
  SET
    status     = v_canonical,
    priority   = COALESCE(p_priority, priority),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',  true,
    'order_id', p_order_id,
    'status',   p_status,
    'priority', COALESCE(p_priority, v_order.priority)
  );
END;
$$;
