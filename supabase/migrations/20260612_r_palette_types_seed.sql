-- Crée la table si elle n'existe pas encore (au cas où)
CREATE TABLE IF NOT EXISTS public.palette_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label      text NOT NULL,
  length     numeric,
  width      numeric,
  height     numeric,
  poids_max  numeric,
  tare_weight numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ajoute tare_weight si la table existait déjà sans cette colonne
ALTER TABLE public.palette_types
  ADD COLUMN IF NOT EXISTS tare_weight numeric NOT NULL DEFAULT 0;

-- Seed types bois standard (idempotent : n'insère que si absent)
INSERT INTO public.palette_types (label, length, width, height, poids_max, tare_weight)
SELECT t.label, t.length, t.width, t.height, t.poids_max, t.tare_weight
FROM (VALUES
  ('EUR / EPAL',        120::numeric, 80::numeric,  15::numeric, 1500::numeric, 22::numeric),
  ('Demi-palette bois',  80::numeric, 60::numeric,  15::numeric,  750::numeric, 13::numeric),
  ('Quart palette bois', 60::numeric, 40::numeric,  15::numeric,  350::numeric,  8::numeric),
  ('Palette industrie', 120::numeric,100::numeric,  15::numeric, 2000::numeric, 28::numeric)
) AS t(label, length, width, height, poids_max, tare_weight)
WHERE NOT EXISTS (
  SELECT 1 FROM public.palette_types WHERE palette_types.label = t.label
);
