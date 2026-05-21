-- ============================================================
-- HOTFIX G : get_stock_snapshot_by_components
--
-- La fonction lisait depuis stock_movements (ancienne TABLE, maintenant VIEW
-- sur mouvements qui est vide) → retournait 0 pour tous les composants
-- → dashboard affichait STOCK TOTAL = 0 et STOCK DISPONIBLE = 0.
--
-- Correction : lire depuis composants.stock et composants.reserved_stock
-- qui sont les colonnes autoritatives maintenues par trigger.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_stock_snapshot_by_components(component_ids uuid[])
RETURNS TABLE (
  composant_id  uuid,
  available_stock integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id                                                          AS composant_id,
    GREATEST(0, COALESCE(c.stock, 0) - COALESCE(c.reserved_stock, 0))::integer AS available_stock
  FROM public.composants c
  WHERE c.id = ANY(COALESCE(component_ids, '{}'::uuid[]));
$$;
