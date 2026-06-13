-- ============================================================
-- Ajout numéro BL (Bon de Livraison) sur shipments
-- BL = clé de regroupement pour archives et vues client/expédition
-- ============================================================

-- ── 1. Colonne bl_number sur shipments ───────────────────────────────────────
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS bl_number text;

-- Index pour recherche/regroupement par BL
CREATE INDEX IF NOT EXISTS idx_shipments_bl_number
  ON public.shipments (bl_number)
  WHERE bl_number IS NOT NULL;

-- ── 2. Vue v_shipments_with_bl : expéditions groupables par BL ───────────────
CREATE OR REPLACE VIEW public.v_shipments_with_bl AS
SELECT
  s.id,
  s.reference,
  s.bl_number,
  s.status,
  s.client_id,
  c.name        AS client_name,
  s.total_weight,
  s.total_pallets,
  s.created_at,
  s.updated_at
FROM public.shipments s
LEFT JOIN public.clients c ON c.id = s.client_id;

-- ── 3. Vue v_bl_summary : une ligne par BL avec agrégats ─────────────────────
CREATE OR REPLACE VIEW public.v_bl_summary AS
SELECT
  s.bl_number,
  s.client_id,
  c.name                            AS client_name,
  COUNT(s.id)                       AS shipment_count,
  SUM(s.total_weight)               AS total_weight,
  SUM(s.total_pallets)              AS total_pallets,
  MIN(s.created_at)                 AS first_shipment_at,
  MAX(s.created_at)                 AS last_shipment_at,
  ARRAY_AGG(s.reference ORDER BY s.created_at) AS shipment_references
FROM public.shipments s
LEFT JOIN public.clients c ON c.id = s.client_id
WHERE s.bl_number IS NOT NULL
GROUP BY s.bl_number, s.client_id, c.name;
