-- ============================================================
-- RLS — Sécurisation complète des tables publiques
--
-- Objectif : bloquer tout accès anonyme (API directe sans auth)
-- Approche  : TO authenticated sur toutes les tables actives
--             DELETE interdit sur les tables stock/production
--             (RPCs SECURITY DEFINER bypass RLS → pas de régression)
--
-- Tables nouvellement protégées (sans RLS) :
--   shipments, shipment_lines, shipment_pallets, shipment_pallet_lines,
--   palette_types, product_variants
--
-- Tables avec open_all remplacé par TO authenticated :
--   composants, coffrets, nomenclatures, mouvements, production_orders,
--   clients, production_consumption, livraisons, livraison_items,
--   bom_versions, bom_lines, orders, order_lines
-- ============================================================

BEGIN;

-- ── 1. Suppression des policies "open_all" (accès anonyme) ──────────────────

DROP POLICY IF EXISTS "open_all" ON public.composants;
DROP POLICY IF EXISTS "open_all" ON public.coffrets;
DROP POLICY IF EXISTS "open_all" ON public.nomenclatures;
DROP POLICY IF EXISTS "open_all" ON public.mouvements;
DROP POLICY IF EXISTS "open_all" ON public.production_orders;
DROP POLICY IF EXISTS "open_all" ON public.livraisons;
DROP POLICY IF EXISTS "open_all" ON public.livraison_items;
DROP POLICY IF EXISTS "open_all" ON public.clients;
DROP POLICY IF EXISTS "open_all" ON public.production_consumption;
DROP POLICY IF EXISTS "open_all" ON public.bom_versions;
DROP POLICY IF EXISTS "open_all" ON public.bom_lines;
DROP POLICY IF EXISTS "open_all" ON public.orders;
DROP POLICY IF EXISTS "open_all" ON public.order_lines;

-- Supprimer aussi authenticated_full_access sur les tables où on redéfinit
-- des policies granulaires (évite les doublons)
DROP POLICY IF EXISTS "authenticated_full_access" ON public.composants;
DROP POLICY IF EXISTS "authenticated_full_access" ON public.coffrets;
DROP POLICY IF EXISTS "authenticated_full_access" ON public.nomenclatures;
DROP POLICY IF EXISTS "authenticated_full_access" ON public.mouvements;
DROP POLICY IF EXISTS "authenticated_full_access" ON public.production_orders;
DROP POLICY IF EXISTS "authenticated_full_access" ON public.production_consumption;

-- ── 2. Activation RLS sur tables sans protection ────────────────────────────

ALTER TABLE public.shipments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_pallets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_pallet_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.palette_types          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants       ENABLE ROW LEVEL SECURITY;

-- ── 3. Policies par table ────────────────────────────────────────────────────

-- composants
-- INSERT/UPDATE directs depuis frontend ; DELETE via RPC safe_delete_composant
-- (SECURITY DEFINER → bypass RLS, pas de régression)
CREATE POLICY "auth_select" ON public.composants FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert" ON public.composants FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update" ON public.composants FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- coffrets
-- INSERT/UPDATE directs ; DELETE via RPC soft_delete_coffret (SECURITY DEFINER)
-- Trigger tg_sync_product_variant_from_coffret est SECURITY DEFINER → bypass RLS
CREATE POLICY "auth_select" ON public.coffrets FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert" ON public.coffrets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update" ON public.coffrets FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- nomenclatures (lignes BOM)
-- INSERT et DELETE directs depuis frontend
CREATE POLICY "auth_select" ON public.nomenclatures FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert" ON public.nomenclatures FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_delete" ON public.nomenclatures FOR DELETE TO authenticated USING (true);

-- mouvements
-- SELECT seul côté frontend ; INSERT exclusivement via RPCs SECURITY DEFINER
CREATE POLICY "auth_select" ON public.mouvements FOR SELECT TO authenticated USING (true);

-- production_orders
-- SELECT + UPDATE direct (champ client_of_reference uniquement)
-- INSERT/DELETE exclusivement via RPCs SECURITY DEFINER
CREATE POLICY "auth_select" ON public.production_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_update" ON public.production_orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- clients
-- SELECT/INSERT/UPDATE/DELETE directs depuis frontend
CREATE POLICY "auth_full" ON public.clients FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- shipments
-- SELECT/INSERT/UPDATE/DELETE directs depuis frontend
CREATE POLICY "auth_full" ON public.shipments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- shipment_lines
-- SELECT/INSERT/DELETE directs depuis frontend
CREATE POLICY "auth_full" ON public.shipment_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- shipment_pallets
-- SELECT/INSERT/DELETE directs depuis frontend
CREATE POLICY "auth_full" ON public.shipment_pallets FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- shipment_pallet_lines
-- SELECT/INSERT depuis frontend ; pas de DELETE direct observé
CREATE POLICY "auth_select" ON public.shipment_pallet_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert" ON public.shipment_pallet_lines FOR INSERT TO authenticated WITH CHECK (true);

-- palette_types
-- Référentiel lecture seule côté frontend
CREATE POLICY "auth_select" ON public.palette_types FOR SELECT TO authenticated USING (true);

-- product_variants
-- SELECT seul côté frontend ; INSERT/UPDATE/DELETE via trigger SECURITY DEFINER
CREATE POLICY "auth_select" ON public.product_variants FOR SELECT TO authenticated USING (true);

-- production_consumption
-- SELECT seul côté frontend ; toutes mutations via RPCs SECURITY DEFINER
CREATE POLICY "auth_select" ON public.production_consumption FOR SELECT TO authenticated USING (true);

-- Tables legacy (livraisons / livraison_items) — remplacées par shipments,
-- conservées par précaution
CREATE POLICY "auth_full" ON public.livraisons      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full" ON public.livraison_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Tables commerciales (bom_versions, bom_lines, orders, order_lines)
CREATE POLICY "auth_full" ON public.bom_versions  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full" ON public.bom_lines     FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full" ON public.orders        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_full" ON public.order_lines   FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
