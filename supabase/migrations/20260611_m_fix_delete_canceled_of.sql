-- ============================================================
-- MIGRATION M : correctif delete_canceled_production_order
--
-- La FK stock_reservations.production_order_id n'a pas ON DELETE CASCADE
-- dans l'instance de production → le DELETE sur production_orders échoue.
-- On supprime explicitement les lignes enfants dans l'ordre correct
-- avant de supprimer l'OF lui-même.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_canceled_production_order(
  p_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
  FROM   public.production_orders
  WHERE  id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OF introuvable');
  END IF;

  IF v_order.status::text NOT IN ('canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'Seuls les OFs annulés peuvent être supprimés (statut actuel : ' || v_order.status::text || ')'
    );
  END IF;

  -- Supprimer les enregistrements enfants explicitement
  -- (on ne suppose pas ON DELETE CASCADE sur les FK de production)
  DELETE FROM public.stock_reservations    WHERE production_order_id = p_order_id;
  DELETE FROM public.production_consumption WHERE production_order_id = p_order_id;

  -- production_order_idempotency.order_id → SET NULL via FK, pas besoin de DELETE
  -- mouvements.production_order_id        → sans FK, historique conservé

  DELETE FROM public.production_orders WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',   true,
    'order_id',  p_order_id,
    'reference', v_order.reference
  );
END;
$$;
