-- ============================================================
-- MIGRATION P : rendre delete_archived_production_order idempotent
--
-- Problème : un second appel avec le même order_id retournait
--   success=false + error='OF introuvable' (ligne déjà supprimée).
--   Le client levait alors une erreur toast pour une opération
--   qui avait déjà réussi — comportement trompeur.
--
--   Cas concrets déclencheurs :
--     • Double-clic sur le bouton de suppression
--     • Deux onglets simultanés sur la même fabrication
--     • Retry réseau après timeout
--
-- Correction : retourner success=true avec already_deleted=true
--   lorsque la ligne est introuvable. L'appelant peut distinguer
--   une suppression fraîche (already_deleted absent) d'une
--   suppression déjà effectuée (already_deleted=true).
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_archived_production_order(
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

  -- Idempotent : la ligne a déjà été supprimée (double-clic, retry réseau,
  -- suppression concurrente). On retourne success=true pour ne pas alarmer
  -- l'utilisateur avec un faux message d'erreur.
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success',       true,
      'order_id',      p_order_id,
      'already_deleted', true
    );
  END IF;

  IF v_order.status::text NOT IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error',   'Seuls les OFs terminés ou annulés peuvent être supprimés (statut actuel : ' || v_order.status::text || ')'
    );
  END IF;

  -- Supprimer les enregistrements enfants explicitement
  -- (FK production → pas de ON DELETE CASCADE garanti en prod)
  -- mouvements.production_order_id → sans FK, historique conservé
  DELETE FROM public.stock_reservations     WHERE production_order_id = p_order_id;
  DELETE FROM public.production_consumption WHERE production_order_id = p_order_id;
  DELETE FROM public.production_orders      WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',   true,
    'order_id',  p_order_id,
    'reference', v_order.reference
  );
END;
$$;
