-- ============================================================
-- MIGRATION O : correctif TOCTOU dans delete_production_orders_period
--
-- Problème : la fonction sélectionne d'abord les IDs à supprimer
--   (SELECT array_agg), puis les supprime dans un second temps.
--   Sous READ COMMITTED (isolation par défaut PostgreSQL), une
--   transaction concurrente peut modifier le statut d'un OF entre
--   le SELECT et le DELETE → risque de supprimer un OF actif.
--
-- Correction : utiliser une CTE avec FOR UPDATE pour verrouiller
--   les lignes au moment du SELECT. Le verrou empêche toute
--   modification concurrente jusqu'à la fin de la transaction.
--   Un re-filtrage du statut dans le DELETE final (belt-and-suspenders)
--   protège contre les cas où le verrou ne suffirait pas.
--
-- Impact : aucun changement fonctionnel visible. La fonction reste
--   appelée de la même façon avec les mêmes paramètres.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_production_orders_period(
  p_statuses text[],          -- ex: ARRAY['done','canceled']
  p_before   timestamptz      -- NULL = aucune limite de date (tout)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids   uuid[];
  v_count integer := 0;
BEGIN
  IF p_statuses IS NULL OR array_length(p_statuses, 1) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Au moins un statut requis');
  END IF;

  -- Sélectionne ET verrouille les OFs correspondants en une seule passe.
  -- FOR UPDATE empêche toute transaction concurrente de modifier le statut
  -- de ces lignes jusqu'à la fin de cette transaction (COMMIT/ROLLBACK).
  -- Sans ce verrou, un OF passant de 'done' → 'in_progress' entre le SELECT
  -- et le DELETE serait supprimé à tort avec ses réservations.
  WITH locked AS (
    SELECT id
    FROM   public.production_orders
    WHERE  status::text = ANY(p_statuses)
      AND  (p_before IS NULL OR created_at < p_before)
    FOR UPDATE
  )
  SELECT array_agg(id)
  INTO   v_ids
  FROM   locked;

  IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('success', true, 'deleted_count', 0);
  END IF;

  DELETE FROM public.stock_reservations     WHERE production_order_id = ANY(v_ids);
  DELETE FROM public.production_consumption WHERE production_order_id = ANY(v_ids);

  -- Re-filtrage du statut en dernière garde : si malgré le verrou un OF
  -- a changé de statut (ex: bug dans un trigger ou intervention admin),
  -- on ne supprime que les lignes dont le statut est toujours terminal.
  DELETE FROM public.production_orders
  WHERE  id = ANY(v_ids)
    AND  status::text = ANY(p_statuses);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'deleted_count', v_count);
END;
$$;
