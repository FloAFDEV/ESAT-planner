-- Ajustements schema requis par l'UI de gestion
begin;

alter table if exists public.coffrets
  add column if not exists is_active boolean default true;

-- Une seule ligne nomenclature par couple coffret/composant
create unique index if not exists ux_nomenclatures_coffret_composant
  on public.nomenclatures(coffret_id, composant_id);

-- Une seule liaison palette type par coffret
create unique index if not exists ux_coffret_palettes_coffret_type
  on public.coffret_palettes(coffret_id, palette_type_id);

commit;
