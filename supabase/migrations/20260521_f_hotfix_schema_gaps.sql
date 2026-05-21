-- ============================================================
-- HOTFIX F : colonnes et contraintes manquantes détectées
--            après introspection du schéma réel de la DB.
--
-- Problèmes bloquants (400 sur create_production_order_atomic) :
--   1. production_order_idempotency n'a pas de colonne order_id
--      → INSERT (idempotency_key, order_id) échoue immédiatement.
--   2. production_consumption n'a pas de contrainte UNIQUE
--      (production_order_id, composant_id)
--      → ON CONFLICT (...) DO NOTHING est invalide sans unique index.
--   3. stock_reservations n'a pas de colonne updated_at
--      → UPDATE SET updated_at = now() échoue dans validate et cancel.
-- ============================================================

-- 1. Ajouter order_id à production_order_idempotency
ALTER TABLE public.production_order_idempotency
  ADD COLUMN IF NOT EXISTS order_id uuid
    REFERENCES public.production_orders(id) ON DELETE SET NULL;

-- 2. Ajouter la contrainte UNIQUE sur production_consumption
--    (sans elle, ON CONFLICT ne peut pas fonctionner)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_consumption_order_composant_key'
      AND conrelid = 'public.production_consumption'::regclass
  ) THEN
    -- Supprimer les doublons éventuels avant d'ajouter la contrainte
    DELETE FROM public.production_consumption a
    USING public.production_consumption b
    WHERE a.id > b.id
      AND a.production_order_id = b.production_order_id
      AND a.composant_id = b.composant_id;

    ALTER TABLE public.production_consumption
      ADD CONSTRAINT production_consumption_order_composant_key
      UNIQUE (production_order_id, composant_id);
  END IF;
END $$;

-- 3. Ajouter updated_at à stock_reservations
ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
