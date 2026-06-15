-- ============================================================
-- ÉVOLUTION SCHÉMA : product_variants → entité produit générique
--
-- Contexte : le système doit supporter des produits expédiables
-- indépendants des coffrets (sachets, pièces unitaires, etc.).
--
-- product_variants reste une TABLE (non convertie en VIEW).
--
-- Ce script ajoute uniquement des colonnes optionnelles.
-- Aucune colonne existante modifiée. Aucune contrainte renforcée.
-- Toutes les colonnes nouvelles sont nullable avec default null.
-- Migration non-destructive, rejouable (IF NOT EXISTS).
-- ============================================================

BEGIN;

-- ── 1. Colonne type ───────────────────────────────────────────────────────
-- Discriminant métier. Valeurs attendues : 'coffret' | 'sachet' | 'unitaire'
-- NULL = produit legacy sans type explicite (compatible avec l'existant)
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS type text DEFAULT NULL;

-- Backfill : tous les produits actuels sont des coffrets
UPDATE public.product_variants
SET type = 'coffret'
WHERE type IS NULL;

-- ── 2. Colonne source_coffret_id ──────────────────────────────────────────
-- Lien optionnel vers coffrets.id pour les variantes dérivées d'un coffret.
-- NULL pour les produits indépendants (sachets, unitaires).
-- Pas de FK contrainte pour permettre la suppression sans cascade.
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS source_coffret_id uuid DEFAULT NULL;

-- Backfill : pour les produits existants, source = leur id (coffret source = eux-mêmes)
UPDATE public.product_variants
SET source_coffret_id = id
WHERE type = 'coffret' AND source_coffret_id IS NULL;

-- ── 3. Colonne poids_palette ──────────────────────────────────────────────
-- Poids de la palette vide associée à ce produit (reprise depuis coffrets).
-- Nullable : les nouveaux produits non-coffret n'en ont pas nécessairement.
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS poids_palette numeric DEFAULT NULL;

-- Backfill depuis coffrets
UPDATE public.product_variants pv
SET poids_palette = c.poids_palette
FROM public.coffrets c
WHERE pv.source_coffret_id = c.id
  AND pv.poids_palette IS NULL;

-- ── 4. Colonne deleted_at ─────────────────────────────────────────────────
-- Soft-delete natif pour les produits non-coffret.
-- Les coffrets passent par soft_delete_coffret() + trigger de sync.
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- ── 5. Index partiel sur type (performances futures) ─────────────────────
CREATE INDEX IF NOT EXISTS idx_product_variants_type
  ON public.product_variants(type)
  WHERE type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_variants_active
  ON public.product_variants(id)
  WHERE deleted_at IS NULL;

-- ── 6. Mise à jour du trigger de sync coffrets → product_variants ─────────
-- Le trigger existant (migration _aa) gère INSERT/UPDATE mais pas poids_palette.
-- On le met à jour pour inclure ce champ.
CREATE OR REPLACE FUNCTION public.tg_sync_product_variant_from_coffret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    UPDATE public.product_variants
    SET deleted_at = NEW.deleted_at
    WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO public.product_variants (
    id, reference, name, weight, nb_par_palette, poids_palette,
    type, source_coffret_id
  )
  VALUES (
    NEW.id,
    NEW.reference,
    NEW.name,
    COALESCE(NEW.poids_coffret, 0),
    COALESCE(NEW.nb_par_palette, 1),
    NEW.poids_palette,
    'coffret',
    NEW.id
  )
  ON CONFLICT (id) DO UPDATE SET
    reference         = EXCLUDED.reference,
    name              = EXCLUDED.name,
    weight            = EXCLUDED.weight,
    nb_par_palette    = EXCLUDED.nb_par_palette,
    poids_palette     = EXCLUDED.poids_palette,
    deleted_at        = NULL;

  RETURN NEW;
END;
$$;

COMMIT;

-- ============================================================
-- RÉSULTAT FINAL : structure product_variants
--
--   id                uuid        PK
--   reference         text
--   name              text
--   weight            numeric     poids unitaire (kg)
--   nb_par_palette    integer     capacité palette
--   poids_palette     numeric     tare palette (nullable)
--   type              text        'coffret' | 'sachet' | 'unitaire' | ...
--   source_coffret_id uuid        nullable — lien vers coffrets.id si dérivé
--   deleted_at        timestamptz nullable — soft-delete natif
--   created_at        timestamptz
--   updated_at        timestamptz
--
-- Pour ajouter un nouveau type de produit expédiable :
--   INSERT INTO product_variants (reference, name, weight, nb_par_palette, type)
--   VALUES ('SAC-001', 'Sachet 100g', 0.1, 50, 'sachet');
-- ============================================================
