-- Policies minimales pour debug affichage dashboard + ecrans ERP
-- A executer dans Supabase SQL Editor avec role proprietaire.

begin;

-- Active RLS explicitement (safe si deja active)
alter table if exists public.composants enable row level security;
alter table if exists public.coffrets enable row level security;
alter table if exists public.production_orders enable row level security;
alter table if exists public.orders enable row level security;
alter table if exists public.order_lines enable row level security;
alter table if exists public.clients enable row level security;
alter table if exists public.bom_versions enable row level security;
alter table if exists public.bom_lines enable row level security;
alter table if exists public.product_variants enable row level security;
alter table if exists public.nomenclatures enable row level security;
alter table if exists public.palette_types enable row level security;
alter table if exists public.coffret_palettes enable row level security;
alter table if exists public.livraisons enable row level security;
alter table if exists public.livraison_items enable row level security;
alter table if exists public.shipments enable row level security;
alter table if exists public.shipment_lines enable row level security;
alter table if exists public.shipment_pallets enable row level security;
alter table if exists public.shipment_pallet_lines enable row level security;

-- Policies lecture (anon/authenticated)
drop policy if exists p_read_composants on public.composants;
create policy p_read_composants on public.composants for select to anon, authenticated using (true);

drop policy if exists p_read_coffrets on public.coffrets;
create policy p_read_coffrets on public.coffrets for select to anon, authenticated using (true);

drop policy if exists p_read_production_orders on public.production_orders;
create policy p_read_production_orders on public.production_orders for select to anon, authenticated using (true);

drop policy if exists p_read_orders on public.orders;
create policy p_read_orders on public.orders for select to anon, authenticated using (true);

drop policy if exists p_read_order_lines on public.order_lines;
create policy p_read_order_lines on public.order_lines for select to anon, authenticated using (true);

drop policy if exists p_read_clients on public.clients;
create policy p_read_clients on public.clients for select to anon, authenticated using (true);

drop policy if exists p_read_bom_versions on public.bom_versions;
create policy p_read_bom_versions on public.bom_versions for select to anon, authenticated using (true);

drop policy if exists p_read_bom_lines on public.bom_lines;
create policy p_read_bom_lines on public.bom_lines for select to anon, authenticated using (true);

drop policy if exists p_read_product_variants on public.product_variants;
create policy p_read_product_variants on public.product_variants for select to anon, authenticated using (true);

drop policy if exists p_read_nomenclatures on public.nomenclatures;
create policy p_read_nomenclatures on public.nomenclatures for select to anon, authenticated using (true);

drop policy if exists p_read_palette_types on public.palette_types;
create policy p_read_palette_types on public.palette_types for select to anon, authenticated using (true);

drop policy if exists p_read_coffret_palettes on public.coffret_palettes;
create policy p_read_coffret_palettes on public.coffret_palettes for select to anon, authenticated using (true);

drop policy if exists p_read_livraisons on public.livraisons;
create policy p_read_livraisons on public.livraisons for select to anon, authenticated using (true);

drop policy if exists p_read_livraison_items on public.livraison_items;
create policy p_read_livraison_items on public.livraison_items for select to anon, authenticated using (true);

drop policy if exists p_read_shipments on public.shipments;
create policy p_read_shipments on public.shipments for select to anon, authenticated using (true);

drop policy if exists p_read_shipment_lines on public.shipment_lines;
create policy p_read_shipment_lines on public.shipment_lines for select to anon, authenticated using (true);

drop policy if exists p_read_shipment_pallets on public.shipment_pallets;
create policy p_read_shipment_pallets on public.shipment_pallets for select to anon, authenticated using (true);

drop policy if exists p_read_shipment_pallet_lines on public.shipment_pallet_lines;
create policy p_read_shipment_pallet_lines on public.shipment_pallet_lines for select to anon, authenticated using (true);

-- Policies ecriture minimales pour ecrans de gestion ERP
-- Ajuster ensuite selon tenant_id et profils.
drop policy if exists p_write_coffrets on public.coffrets;
create policy p_write_coffrets on public.coffrets for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_nomenclatures on public.nomenclatures;
create policy p_write_nomenclatures on public.nomenclatures for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_palette_types on public.palette_types;
create policy p_write_palette_types on public.palette_types for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_coffret_palettes on public.coffret_palettes;
create policy p_write_coffret_palettes on public.coffret_palettes for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_livraisons on public.livraisons;
create policy p_write_livraisons on public.livraisons for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_livraison_items on public.livraison_items;
create policy p_write_livraison_items on public.livraison_items for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_shipments on public.shipments;
create policy p_write_shipments on public.shipments for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_shipment_lines on public.shipment_lines;
create policy p_write_shipment_lines on public.shipment_lines for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_shipment_pallets on public.shipment_pallets;
create policy p_write_shipment_pallets on public.shipment_pallets for all to anon, authenticated using (true) with check (true);

drop policy if exists p_write_shipment_pallet_lines on public.shipment_pallet_lines;
create policy p_write_shipment_pallet_lines on public.shipment_pallet_lines for all to anon, authenticated using (true) with check (true);

commit;
