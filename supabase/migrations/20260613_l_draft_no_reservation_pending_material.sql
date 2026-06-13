-- ============================================================
-- MIGRATION L : Draft sans réservation + pending_material réel
--
-- Objectif : séparer création (brouillon) et lancement (exécution)
--
-- Avant : create_production_order_atomic crée toujours des réservations
--         → stock impacté dès le brouillon
--         → pending_material = statut virtuel frontend uniquement
--
-- Après : 
--   • draft → zéro réservation, zéro impact stock
--   • lancement (transition draft→in_progress) :
--       - crée les réservations
--       - si stock OK → in_progress
--       - si stock insuffisant → pending_material (statut DB réel)
--   • pending_material → relance re-vérifie le stock réel
-- ============================================================

-- ── 1. Ajouter pending_material à l'enum ────────────────────────────────
ALTER TYPE public.production_status ADD VALUE IF NOT EXISTS 'pending_material';

-- ── 2. Remplacer create_production_order_atomic ─────────────────────────
--    Supprime : réservation stock, production_consumption, can_start_now
--    Conserve : idempotence, validation coffret/BOM, création OF

DROP FUNCTION IF EXISTS public.create_production_order_atomic(
  uuid, integer, text, integer, text, text
);

CREATE OR REPLACE FUNCTION public.create_production_order_atomic(
  p_coffret_id      uuid,
  p_quantity        integer,
  p_status          text    DEFAULT 'draft',
  p_priority        integer DEFAULT 0,
  p_notes           text    DEFAULT NULL,
  p_idempotency_key text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id   uuid;
  v_reference  text;
  v_inserted   integer;
BEGIN
  -- ── Validation des paramètres ──────────────────────────────────────────
  IF p_coffret_id IS NULL THEN
    RAISE EXCEPTION 'p_coffret_id is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'p_quantity must be > 0';
  END IF;
  IF p_priority IS NULL OR p_priority NOT IN (0, 1) THEN
    RAISE EXCEPTION 'p_priority must be 0 or 1';
  END IF;
  IF p_status NOT IN ('draft', 'priority') THEN
    RAISE EXCEPTION 'invalid initial status (must be draft or priority)';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required';
  END IF;

  -- ── Idempotence ────────────────────────────────────────────────────────
  INSERT INTO public.production_order_idempotency (idempotency_key, order_id)
  VALUES (p_idempotency_key, NULL)
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT poi.order_id, po.reference
    INTO   v_order_id, v_reference
    FROM   public.production_order_idempotency poi
    LEFT JOIN public.production_orders po ON po.id = poi.order_id
    WHERE  poi.idempotency_key = p_idempotency_key;

    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success',           true,
        'order_id',          v_order_id,
        'reference',         v_reference,
        'idempotent_replay', true
      );
    END IF;
    RAISE EXCEPTION 'idempotency key conflict: %', p_idempotency_key;
  END IF;

  -- ── Validations métier ────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'coffret not found or archived: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nomenclatures WHERE coffret_id = p_coffret_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'no active BOM lines found for coffret %', p_coffret_id;
  END IF;

  -- ── Création de l'ordre (brouillon, sans réservation) ─────────────────
  INSERT INTO public.production_orders (
    coffret_id, quantity, status, priority, notes, can_start_now
  )
  VALUES (
    p_coffret_id,
    p_quantity,
    p_status::public.production_status,
    p_priority,
    p_notes,
    NULL   -- inconnu jusqu'au lancement
  )
  RETURNING id, reference INTO v_order_id, v_reference;

  -- ── Finalisation idempotency ──────────────────────────────────────────
  UPDATE public.production_order_idempotency
  SET order_id = v_order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'success',   true,
    'order_id',  v_order_id,
    'reference', v_reference,
    'status',    p_status,
    'priority',  p_priority
  );
END;
$$;


-- ── 3. Remplacer transition_production_order_status ──────────────────────
--    Ajoute : création réservations au lancement (draft→in_progress)
--    Remplace : garde bloquante → routing vers pending_material

DROP FUNCTION IF EXISTS public.transition_production_order_status(uuid, text);
DROP FUNCTION IF EXISTS public.transition_production_order_status(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.transition_production_order_status(
  p_order_id uuid,
  p_status   text,
  p_priority integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order         public.production_orders%ROWTYPE;
  v_final_status  public.production_status;
  v_missing_count integer := 0;
  v_missing_list  text    := '';
  v_phys_stock    integer;
  v_sr            record;
  v_need          record;
  v_available     integer;
  v_has_reserv    boolean;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Valider le statut cible
  IF p_status NOT IN ('draft', 'priority', 'in_progress', 'partial', 'done', 'pending_material') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid status'
    );
  END IF;

  -- États terminaux : aucune transition possible
  IF v_order.status::text IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot transition from terminal status ' || v_order.status::text
    );
  END IF;

  -- ── Lancement : draft / priority → in_progress ────────────────────────
  -- Crée les réservations si elles n'existent pas encore,
  -- puis route vers in_progress ou pending_material selon le stock réel.
  IF p_status = 'in_progress'
     AND v_order.status::text IN ('draft', 'priority')
  THEN
    -- Vérifier si des réservations existent déjà (idempotence)
    SELECT EXISTS (
      SELECT 1 FROM public.stock_reservations
      WHERE production_order_id = p_order_id AND status = 'active'
    ) INTO v_has_reserv;

    IF NOT v_has_reserv THEN
      -- Verrouillage anti-race condition
      PERFORM 1
      FROM public.composants c
      JOIN public.nomenclatures n ON n.composant_id = c.id
      WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
      ORDER BY c.id
      FOR UPDATE;

      -- Créer les réservations
      INSERT INTO public.stock_reservations (
        composant_id, quantity, production_order_id, status
      )
      SELECT
        n.composant_id,
        (n.quantity * v_order.quantity)::integer,
        p_order_id,
        'active'
      FROM public.nomenclatures n
      WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true;

      -- Créer le BOM prévisionnel (audit)
      INSERT INTO public.production_consumption (
        production_order_id, composant_id, quantity
      )
      SELECT
        p_order_id,
        n.composant_id,
        (n.quantity * v_order.quantity)::integer
      FROM public.nomenclatures n
      WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
      ON CONFLICT (production_order_id, composant_id) DO NOTHING;
    END IF;

    -- Vérifier le stock physique vs réservations
    FOR v_sr IN
      SELECT
        sr.composant_id,
        sr.quantity          AS reserved_qty,
        COALESCE(c.reference, c.id::text) AS ref,
        COALESCE(c.name, '') AS nom
      FROM public.stock_reservations sr
      JOIN public.composants c ON c.id = sr.composant_id
      WHERE sr.production_order_id = p_order_id AND sr.status = 'active'
    LOOP
      SELECT COALESCE(c.stock, 0)
      INTO v_phys_stock
      FROM public.composants c
      WHERE c.id = v_sr.composant_id;

      IF v_phys_stock < v_sr.reserved_qty THEN
        v_missing_count := v_missing_count + 1;
        v_missing_list  := v_missing_list
          || CASE WHEN v_missing_list <> '' THEN ', ' ELSE '' END
          || v_sr.ref
          || ' (manque ' || (v_sr.reserved_qty - v_phys_stock)::text || ')';
      END IF;
    END LOOP;

    -- Routing : stock OK → in_progress, sinon → pending_material
    v_final_status := CASE
      WHEN v_missing_count = 0 THEN 'in_progress'::public.production_status
      ELSE 'pending_material'::public.production_status
    END;

    UPDATE public.production_orders
    SET
      status        = v_final_status,
      can_start_now = (v_missing_count = 0),
      priority      = COALESCE(p_priority, priority),
      updated_at    = now()
    WHERE id = p_order_id;

    RETURN jsonb_build_object(
      'success',       true,
      'order_id',      p_order_id,
      'status',        v_final_status::text,
      'missing_count', v_missing_count,
      'missing_list',  v_missing_list
    );
  END IF;

  -- ── Relance : pending_material → in_progress ──────────────────────────
  -- Re-vérifie le stock physique. Si OK → in_progress. Sinon → erreur.
  IF p_status = 'in_progress' AND v_order.status::text = 'pending_material' THEN
    FOR v_sr IN
      SELECT
        sr.composant_id,
        sr.quantity          AS reserved_qty,
        COALESCE(c.reference, c.id::text) AS ref
      FROM public.stock_reservations sr
      JOIN public.composants c ON c.id = sr.composant_id
      WHERE sr.production_order_id = p_order_id AND sr.status = 'active'
    LOOP
      SELECT COALESCE(c.stock, 0)
      INTO v_phys_stock
      FROM public.composants c
      WHERE c.id = v_sr.composant_id;

      IF v_phys_stock < v_sr.reserved_qty THEN
        v_missing_count := v_missing_count + 1;
        v_missing_list  := v_missing_list
          || CASE WHEN v_missing_list <> '' THEN ', ' ELSE '' END
          || v_sr.ref
          || ' (manque ' || (v_sr.reserved_qty - v_phys_stock)::text || ')';
      END IF;
    END LOOP;

    IF v_missing_count > 0 THEN
      RETURN jsonb_build_object(
        'success',       false,
        'error',         'Il manque encore des pièces : ' || v_missing_list,
        'missing_count', v_missing_count
      );
    END IF;

    UPDATE public.production_orders
    SET
      status        = 'in_progress'::public.production_status,
      can_start_now = true,
      priority      = COALESCE(p_priority, priority),
      updated_at    = now()
    WHERE id = p_order_id;

    RETURN jsonb_build_object(
      'success',  true,
      'order_id', p_order_id,
      'status',   'in_progress'
    );
  END IF;

  -- ── Transition standard (tous les autres cas) ─────────────────────────
  v_final_status := p_status::public.production_status;

  UPDATE public.production_orders
  SET
    status     = v_final_status,
    priority   = COALESCE(p_priority, priority),
    updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success',  true,
    'order_id', p_order_id,
    'status',   p_status,
    'priority', COALESCE(p_priority, v_order.priority)
  );
END;
$$;
