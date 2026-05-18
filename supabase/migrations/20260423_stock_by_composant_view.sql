-- Vue de stock agrégé par composant.
-- Source de vérité: stock_movements uniquement.

CREATE OR REPLACE VIEW public.stock_by_composant AS
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
  )::bigint AS total_stock
FROM public.stock_movements sm
GROUP BY sm.composant_id;
