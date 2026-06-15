-- ============================================================
-- SYNC product_variants ← coffrets
--
-- Contexte : product_variants est une TABLE dérivée de coffrets.
-- Aucun mécanisme d'INSERT automatique n'existait → 34 coffrets
-- créés depuis l'UI sont absents de product_variants (31 vs 65).
--
-- Ce script :
--   1. Backfill des coffrets manquants (INSERT ... WHERE NOT IN)
--   2. Trigger AFTER INSERT OR UPDATE ON coffrets pour sync future
--
-- Option B (conversion en VIEW) est documentée en bas de fichier
-- mais NON appliquée ici — nécessite validation impact FK.
-- ============================================================

BEGIN;

-- ── 1. BACKFILL : insérer les coffrets manquants ─────────────────────────
--
-- Colonnes minimales attendues par le frontend :
--   id, reference, name, weight (=poids_coffret), nb_par_palette
-- Colonnes supplémentaires connues dans la TABLE (ajoutées par migrations _t, _v) :
--   weight, nb_par_palette
-- On insère ce que la TABLE peut accepter selon ses colonnes actuelles.

INSERT INTO public.product_variants (id, reference, name, weight, nb_par_palette)
SELECT
  c.id,
  c.reference,
  c.name,
  COALESCE(c.poids_coffret, 0),
  COALESCE(c.nb_par_palette, 1)
FROM public.coffrets c
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.product_variants pv WHERE pv.id = c.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.product_variants pv WHERE pv.reference = c.reference
  );

-- ── 2. RESYNC des lignes existantes (weight + nb_par_palette à jour) ──────
UPDATE public.product_variants pv
SET
  reference      = c.reference,
  name           = c.name,
  weight         = COALESCE(c.poids_coffret, 0),
  nb_par_palette = COALESCE(c.nb_par_palette, 1)
FROM public.coffrets c
WHERE pv.id = c.id;

-- ── 3. TRIGGER : sync automatique à chaque INSERT ou UPDATE sur coffrets ──

CREATE OR REPLACE FUNCTION public.tg_sync_product_variant_from_coffret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Soft-delete : retirer de product_variants si coffret archivé
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM public.product_variants WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  -- Upsert : crée ou met à jour la ligne dans product_variants
  INSERT INTO public.product_variants (id, reference, name, weight, nb_par_palette)
  VALUES (
    NEW.id,
    NEW.reference,
    NEW.name,
    COALESCE(NEW.poids_coffret, 0),
    COALESCE(NEW.nb_par_palette, 1)
  )
  ON CONFLICT (id) DO UPDATE SET
    reference      = EXCLUDED.reference,
    name           = EXCLUDED.name,
    weight         = EXCLUDED.weight,
    nb_par_palette = EXCLUDED.nb_par_palette;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_sync_product_variant_from_coffret ON public.coffrets;
CREATE TRIGGER tg_sync_product_variant_from_coffret
AFTER INSERT OR UPDATE ON public.coffrets
FOR EACH ROW EXECUTE FUNCTION public.tg_sync_product_variant_from_coffret();

COMMIT;

-- ============================================================
-- OPTION B — Conversion VIEW (non appliquée ici)
--
-- Requiert :
--   1. DROP CONSTRAINT shipment_lines_product_variant_id_fkey
--   2. DROP TABLE product_variants CASCADE
--   3. CREATE VIEW product_variants AS SELECT ... FROM coffrets WHERE deleted_at IS NULL
--   4. Recréer FK sur coffrets.id directement dans shipment_lines
--
-- À valider séparément si Option A montre des limites.
-- ============================================================
