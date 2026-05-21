-- ============================================================
-- NETTOYAGE LEGACY
-- Supprime les fonctions obsolètes qui référencent des tables
-- inexistantes (coffret_components) ou des logiques dépassées.
-- ============================================================

-- 1. create_production_order_safe référençait bom_versions/bom_lines
--    et coffret_components → obsolète depuis la migration vers nomenclatures.
DROP FUNCTION IF EXISTS public.create_production_order_safe(
  uuid, integer, text, text
);

-- 2. check_production_feasibility_multi référençait bom_versions/bom_lines
DROP FUNCTION IF EXISTS public.check_production_feasibility_multi(jsonb);

-- 3. L'ancienne version de validate_production_order sans p_qty
--    a été remplacée par la version avec p_qty DEFAULT NULL.
--    Pas besoin de DROP car même signature.

-- 4. Commentaire documentaire : tables legacy conservées comme archives
--    bom_versions, bom_lines : non utilisées dans le flux actuel.
--    Peuvent être supprimées si la migration des données est confirmée.
--    product_variants (VIEW) : le FK vers elle depuis shipment_lines
--    était invalide en PostgreSQL (FK sur VIEW impossible).
--    La contrainte n'a jamais été active. Documenter et corriger si besoin.

COMMENT ON TABLE public.production_consumption IS
  'Audit BOM : consommations prévues à la création de l''OF. '
  'Immuable après création.';

COMMENT ON FUNCTION public.create_production_order_atomic IS
  'Crée un OF + réserve le stock. Idempotent via p_idempotency_key. '
  'v3 — 2026-05-21 : utilise stock_reservations (source de vérité réservations).';

COMMENT ON FUNCTION public.validate_production_order IS
  'Valide tout ou partie d''un OF. Idempotent sur done. '
  'v2 — 2026-05-21 : gestion partielle (p_qty), liberation réservations, stock_fini.';

COMMENT ON FUNCTION public.cancel_production_order_with_unreserve IS
  'Annule un OF et libère les réservations actives restantes. '
  'v2 — 2026-05-21 : utilise statut canonical ''canceled''.';
