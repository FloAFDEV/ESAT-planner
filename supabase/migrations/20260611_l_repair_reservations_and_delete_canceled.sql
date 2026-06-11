-- ============================================================
-- MIGRATION L : réparation réservations orphelines + suppression OFs annulés
--
-- Problème 1 : des réservations en statut 'active' existent pour des OFs
--   en statut 'done' ou 'canceled'. Cela gonfle artificiellemen
--   composants.reserved_stock et fausse l'affichage du stock disponible.
--   Cause probable : OFs validés/annulés via un ancien RPC ou une mise à
--   jour directe qui n'a pas déclenché la mise à jour des réservations.
--
-- Fix : passer ces réservations orphelines en 'canceled'.
--   Le trigger tg_sync_reserved_stock recalculera reserved_stock
--   pour chaque composant affecté.
--   Une passe de recalcul forcé garantit la cohérence même si le
--   trigger ne s'est pas exécuté correctement par le passé.
--
-- Problème 2 : pas de moyen de supprimer les OFs annulés.
--
-- Fix : nouveau RPC delete_canceled_production_order.
--   Vérifie le statut 'canceled', supprime l'OF.
--   Les FK CASCADE s'occupent de stock_reservations et
--   production_consumption. L'historique mouvements est préservé
--   (production_order_id sans FK → reste intact, valeur orpheline).
-- ============================================================


-- ── 1. Réparer les réservations orphelines ────────────────────────────────
-- Les réservations 'active' pour des OFs terminés/annulés sont des fantômes.
-- On les passe en 'canceled' : le trigger recalcule reserved_stock
-- pour chaque composant touché.

UPDATE public.stock_reservations sr
SET    status     = 'canceled',
       updated_at = now()
FROM   public.production_orders po
WHERE  sr.production_order_id = po.id
  AND  sr.status = 'active'
  AND  po.status::text IN ('done', 'canceled', 'termine', 'annule');

-- ── 2. Recalcul de sécurité de reserved_stock ─────────────────────────────
-- Recalcule directement le cache pour tous les composants afin de
-- corriger toute dérive antérieure, indépendamment du trigger.

UPDATE public.composants c
SET    reserved_stock = COALESCE((
  SELECT SUM(sr.quantity)
  FROM   public.stock_reservations sr
  WHERE  sr.composant_id = c.id
    AND  sr.status = 'active'
    AND  sr.quantity > 0
), 0);


-- ── 3. RPC : supprimer un OF annulé ──────────────────────────────────────
-- Seuls les OFs en statut 'canceled' (ou 'annule' legacy) peuvent être
-- supprimés. Les OFs terminés ('done') sont conservés pour l'historique.
--
-- Comportement des FK lors de la suppression de l'OF :
--   stock_reservations      → CASCADE DELETE (déjà annulées, reserved_stock non affecté)
--   production_consumption  → CASCADE DELETE
--   production_order_idempotency.order_id → SET NULL
--   mouvements.production_order_id → sans FK, valeur conservée (historique intact)

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

  DELETE FROM public.production_orders WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',   true,
    'order_id',  p_order_id,
    'reference', v_order.reference
  );
END;
$$;
