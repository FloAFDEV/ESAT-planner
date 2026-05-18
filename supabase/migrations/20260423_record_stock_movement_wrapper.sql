BEGIN;

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

GRANT EXECUTE ON FUNCTION public.record_stock_movement(
  uuid,
  public.mouvement_type,
  integer,
  text,
  text,
  text
) TO anon, authenticated, service_role;

COMMIT;