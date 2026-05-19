-- ============================================================
-- MIGRATION: Soft delete coffrets + snapshot immuable dans production_orders
--
-- Objectif métier:
--   - Ne jamais supprimer physiquement un coffret qui a des ordres de production
--   - Conserver l'historique de production intact même si un coffret est archivé
--   - Garder ON DELETE RESTRICT comme garde-fou ultime
--
-- Architecture:
--   1. coffrets.deleted_at  → soft delete (archivage)
--   2. production_orders.coffret_snapshot → {reference, name} capturé à la création
--   3. Trigger BEFORE INSERT pour auto-populer le snapshot
--   4. Backfill des ordres existants
--   5. RPC soft_delete_coffret() pour l'UI
-- ============================================================

-- ============ 1. Soft delete sur coffrets ============

ALTER TABLE public.coffrets
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Index partiel: seuls les coffrets actifs sont indexés (performances requêtes courantes)
CREATE INDEX IF NOT EXISTS idx_coffrets_active
  ON public.coffrets(id)
  WHERE deleted_at IS NULL;

-- ============ 2. Snapshot immuable dans production_orders ============

ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS coffret_snapshot jsonb DEFAULT NULL;

-- ============ 3. Trigger: auto-snapshot à la création d'un ordre ============

CREATE OR REPLACE FUNCTION public.tg_snapshot_coffret_on_production_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_coffret record;
BEGIN
  SELECT reference, name
  INTO v_coffret
  FROM public.coffrets
  WHERE id = NEW.coffret_id;

  IF FOUND THEN
    NEW.coffret_snapshot := jsonb_build_object(
      'reference', v_coffret.reference,
      'name',      v_coffret.name
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_snapshot_coffret_on_production_order ON public.production_orders;
CREATE TRIGGER tg_snapshot_coffret_on_production_order
BEFORE INSERT ON public.production_orders
FOR EACH ROW EXECUTE FUNCTION public.tg_snapshot_coffret_on_production_order();

-- ============ 4. Backfill des ordres existants ============

UPDATE public.production_orders po
SET coffret_snapshot = jsonb_build_object(
  'reference', c.reference,
  'name',      c.name
)
FROM public.coffrets c
WHERE c.id = po.coffret_id
  AND po.coffret_snapshot IS NULL;

-- ============ 5. RPC: soft_delete_coffret ============
-- Snapshote en dernier recours, puis archive le coffret.
-- La FK ON DELETE RESTRICT reste active: si un bug UI tente un DELETE physique,
-- PostgreSQL bloquera tant qu'il existe des ordres non terminés.

CREATE OR REPLACE FUNCTION public.soft_delete_coffret(p_coffret_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets
    WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'coffret not found or already archived');
  END IF;

  -- Snapshot de sécurité pour les ordres qui n'en auraient pas encore
  UPDATE public.production_orders po
  SET coffret_snapshot = jsonb_build_object(
    'reference', c.reference,
    'name',      c.name
  )
  FROM public.coffrets c
  WHERE c.id = p_coffret_id
    AND po.coffret_id = p_coffret_id
    AND po.coffret_snapshot IS NULL;

  UPDATE public.coffrets
  SET deleted_at = now()
  WHERE id = p_coffret_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('success', true, 'coffret_id', p_coffret_id);
END;
$$;

-- ============ NOTE sur la FK ============
-- La contrainte existante reste ON DELETE RESTRICT:
--   production_orders.coffret_id REFERENCES coffrets(id) ON DELETE RESTRICT
--
-- C'est le comportement correct pour un ERP de production:
--   - Un coffret qui a des ordres actifs NE PEUT PAS être supprimé physiquement
--   - L'interface doit utiliser soft_delete_coffret() à la place
--   - Si on doit vraiment supprimer physiquement, il faut d'abord annuler/archiver tous les ordres
