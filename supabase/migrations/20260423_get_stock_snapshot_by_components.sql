-- Snapshot de stock par composants, calculé uniquement côté PostgreSQL.
-- Source de vérité: stock_movements.

CREATE OR REPLACE FUNCTION public.get_stock_snapshot_by_components(component_ids uuid[])
RETURNS TABLE (
  composant_id uuid,
  available_stock integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    sm.composant_id,
    COALESCE(
      SUM(
        CASE
          WHEN sm.type IN ('IN', 'ADJUST') THEN sm.quantity
          WHEN sm.type = 'OUT' THEN -sm.quantity
          ELSE 0
        END
      ),
      0
    )::integer AS available_stock
  FROM public.stock_movements sm
  WHERE sm.composant_id = ANY(COALESCE(component_ids, '{}'::uuid[]))
  GROUP BY sm.composant_id;
$$;
