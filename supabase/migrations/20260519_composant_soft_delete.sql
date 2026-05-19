-- ============================================================
-- MIGRATION: Soft delete composants + suppression sécurisée
--
-- Architecture décidée:
--   - ON DELETE RESTRICT reste sur toutes les FK composants
--     (mouvements, nomenclatures, bom_lines)
--   - Suppression physique = IMPOSSIBLE si l'historique existe
--   - Seule voie: soft delete + mouvement OUT final pour ramener
--     le stock à zéro (traçabilité complète, ledger intact)
--
-- Règle métier suppression composant:
--   1. Aucun ordre de fabrication actif (draft/priority/in_progress)
--   2. Aucune réservation de stock active
--   3. Pas de nomenclature sur un coffret non archivé
--   4. Si stock > 0: insérer un mouvement OUT final (reason: Suppression)
--   5. Marquer deleted_at = now()
-- ============================================================

-- ============ 1. Soft delete sur composants ============

ALTER TABLE public.composants
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_composants_active
  ON public.composants(id)
  WHERE deleted_at IS NULL;

-- ============ 2. RPC: safe_delete_composant ============

CREATE OR REPLACE FUNCTION public.safe_delete_composant(p_composant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_composant        public.composants%ROWTYPE;
  v_blocking_orders  integer;
  v_blocking_noms    integer;
  v_active_reserves  integer;
BEGIN
  SELECT * INTO v_composant
  FROM public.composants
  WHERE id = p_composant_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'composant not found or already archived'
    );
  END IF;

  -- Vérifier les ordres de fabrication actifs qui consomment ce composant
  SELECT COUNT(*) INTO v_blocking_orders
  FROM public.production_orders po
  JOIN public.nomenclatures n ON n.coffret_id = po.coffret_id AND n.composant_id = p_composant_id
  WHERE po.status::text IN ('draft', 'brouillon', 'priority', 'in_progress', 'en_cours', 'pret');

  IF v_blocking_orders > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'composant_in_active_orders',
      'count', v_blocking_orders,
      'message', 'Ce composant est utilisé dans ' || v_blocking_orders || ' ordre(s) de fabrication actif(s). Terminez ou annulez ces ordres avant de supprimer le composant.'
    );
  END IF;

  -- Vérifier les réservations de stock actives
  SELECT COUNT(*) INTO v_active_reserves
  FROM public.stock_reservations
  WHERE composant_id = p_composant_id AND status = 'active';

  IF v_active_reserves > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'composant_has_active_reservations',
      'count', v_active_reserves,
      'message', 'Ce composant a ' || v_active_reserves || ' réservation(s) de stock active(s).'
    );
  END IF;

  -- Vérifier les nomenclatures sur des coffrets actifs (non archivés)
  SELECT COUNT(*) INTO v_blocking_noms
  FROM public.nomenclatures n
  JOIN public.coffrets c ON c.id = n.coffret_id
  WHERE n.composant_id = p_composant_id
    AND c.deleted_at IS NULL;

  IF v_blocking_noms > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'composant_in_active_bom',
      'count', v_blocking_noms,
      'message', 'Ce composant est présent dans ' || v_blocking_noms || ' nomenclature(s) de coffret(s) actifs. Retirez-le des nomenclatures ou archivez les coffrets concernés.'
    );
  END IF;

  -- Si stock > 0: insérer un mouvement OUT final pour ramener à zéro
  -- (ledger: chaque centime d'inventaire doit être tracé)
  IF v_composant.stock > 0 THEN
    INSERT INTO public.mouvements (
      composant_id,
      type,
      quantity,
      reason
    )
    VALUES (
      p_composant_id,
      'OUT',
      v_composant.stock,
      'Suppression composant ' || v_composant.reference
    );
  END IF;

  -- Soft delete
  UPDATE public.composants
  SET deleted_at = now()
  WHERE id = p_composant_id;

  RETURN jsonb_build_object(
    'success', true,
    'composant_id', p_composant_id,
    'reference', v_composant.reference,
    'stock_drained', v_composant.stock
  );
END;
$$;

-- ============ 3. Vue de vérification FK (diagnostic) ============
-- Requête à exécuter pour confirmer l'état des FK en production:
--
-- SELECT
--   tc.table_name,
--   kcu.column_name,
--   ccu.table_name AS foreign_table,
--   rc.delete_rule
-- FROM information_schema.table_constraints tc
-- JOIN information_schema.key_column_usage kcu
--   ON tc.constraint_name = kcu.constraint_name
--   AND tc.constraint_schema = kcu.constraint_schema
-- JOIN information_schema.referential_constraints rc
--   ON tc.constraint_name = rc.constraint_name
--   AND tc.constraint_schema = rc.constraint_schema
-- JOIN information_schema.constraint_column_usage ccu
--   ON rc.unique_constraint_name = ccu.constraint_name
--   AND rc.constraint_schema = ccu.constraint_schema
-- WHERE tc.constraint_type = 'FOREIGN KEY'
--   AND tc.table_schema = 'public'
-- ORDER BY tc.table_name;
