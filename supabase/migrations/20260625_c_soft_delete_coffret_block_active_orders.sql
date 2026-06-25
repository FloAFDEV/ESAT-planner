-- ============================================================
-- BUG-01 : soft_delete_coffret — bloquer l'archivage si OF actifs
--
-- Ajout d'un guard avant l'UPDATE deleted_at.
-- Si des OF en statut actif (draft / priority / pending_material /
-- in_progress / partial) référencent ce coffret, la RPC refuse
-- et retourne une erreur métier explicite.
-- ============================================================

CREATE OR REPLACE FUNCTION public.soft_delete_coffret(p_coffret_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets
    WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'coffret not found or already archived');
  END IF;

  -- Bloquer l'archivage si des OF actifs existent sur ce coffret
  IF EXISTS (
    SELECT 1 FROM public.production_orders
    WHERE coffret_id = p_coffret_id
      AND status::text IN ('draft', 'priority', 'pending_material', 'in_progress', 'partial')
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'active_orders_exist',
      'message', 'Impossible d''archiver ce coffret : des ordres de fabrication sont encore en cours.'
    );
  END IF;

  -- Snapshot de sécurité pour les ordres qui n'en auraient pas encore
  UPDATE public.production_orders po
  SET coffret_snapshot = jsonb_build_object(
    'reference', c.reference,
    'name',      c.name
  )
  FROM public.coffrets c
  WHERE c.id = p_coffret_id
    AND po.coffret_id = p_coffret_id
    AND po.coffret_snapshot IS NULL;

  UPDATE public.coffrets
  SET deleted_at = now()
  WHERE id = p_coffret_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('success', true, 'coffret_id', p_coffret_id);
END;
$$;
