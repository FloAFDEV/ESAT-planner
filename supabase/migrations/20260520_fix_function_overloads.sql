-- ============================================================
-- CORRECTIF: surcharge de fonctions et logique d'état
--
-- Problèmes:
--   1. create_production_order_atomic existe en plusieurs surcharges
--      incompatibles (p_status public.production_status vs text).
--      PostgreSQL ne peut plus choisir → erreur "could not choose
--      the best candidate function".
--   2. cancel_production_order_with_unreserve vérifie status='termine'
--      mais validate_production_order (20260520) passe à 'done'.
--      Un OF validé peut donc être ré-annulé.
--   3. transition_production_order_status traite 'priority' comme
--      état terminal, bloquant la progression d'un OF urgent.
--
-- Corrections:
--   1. DROP les anciennes surcharges (5-param et 6-param avec
--      public.production_status). Seule la version text est conservée.
--   2. cancel: vérifier 'done' ET 'termine'.
--   3. transition: ne bloquer que depuis 'done', pas depuis 'priority'.
-- ============================================================

-- ============ 1. Suppression des surcharges obsolètes ============

-- Surcharge 5 paramètres (sans p_idempotency_key)
DROP FUNCTION IF EXISTS public.create_production_order_atomic(
  uuid,
  integer,
  public.production_status,
  integer,
  text
);

-- Surcharge 6 paramètres avec p_status en production_status (enum)
DROP FUNCTION IF EXISTS public.create_production_order_atomic(
  uuid,
  integer,
  public.production_status,
  integer,
  text,
  text
);

-- ============ 2. cancel_production_order_with_unreserve ============
-- Vérifie 'done' (nouveau) ET 'termine' (legacy) pour bloquer l'annulation
-- d'un OF déjà validé.

CREATE OR REPLACE FUNCTION public.cancel_production_order_with_unreserve(
  p_order_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Bloque si déjà terminé (statut canonical 'done' ou legacy 'termine')
  IF v_order.status::text IN ('done', 'termine') THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot cancel completed order');
  END IF;

  -- Libère les réservations actives (no-op si aucune dans le nouveau flux)
  UPDATE public.stock_reservations
  SET status = 'canceled'
  WHERE production_order_id = p_order_id AND status = 'active';

  UPDATE public.production_orders
  SET status = 'annule'::public.production_status,
      updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id);
END $$;

-- ============ 3. transition_production_order_status ============
-- 'priority' = marque d'urgence, pas un état terminal.
-- Seul 'done' est terminal (interdit de rétrograder).

CREATE OR REPLACE FUNCTION public.transition_production_order_status(
  p_order_id uuid,
  p_status text,
  p_priority integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.production_orders%ROWTYPE;
  v_canonical_status public.production_status;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  IF p_status NOT IN ('draft', 'in_progress', 'done', 'priority') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'invalid status (must be draft, in_progress, done, or priority)');
  END IF;

  -- Seul 'done' est terminal : impossible de rétrograder depuis 'done'
  IF v_order.status::text IN ('done', 'termine') AND p_status <> 'done' THEN
    RETURN jsonb_build_object('success', false, 'error',
      'cannot revert from completed order');
  END IF;

  v_canonical_status := p_status::public.production_status;

  UPDATE public.production_orders
  SET
    status     = v_canonical_status,
    priority   = COALESCE(p_priority, priority),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',  true,
    'order_id', p_order_id,
    'status',   p_status,
    'priority', COALESCE(p_priority, v_order.priority)
  );
END $$;
