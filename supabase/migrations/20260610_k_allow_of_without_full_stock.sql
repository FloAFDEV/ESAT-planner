-- ============================================================
-- MIGRATION K : planification anticipée + garde in_progress
--
-- P0.2 — Créer un OF même avec stock insuffisant
--   • Ajout colonne production_orders.can_start_now (boolean)
--     → snapshot de faisabilité au moment de la création
--     → NULL pour les OFs historiques (traités comme true dans l'UI)
--   • create_production_order_atomic :
--     la vérification de stock devient consultative (non bloquante)
--     → l'OF est toujours créé, can_start_now reflète la réalité
--     → le retour JSON inclut can_start_now + missing_components
--
-- P0.3 — Bloquer le passage en in_progress si stock physique insuffisant
--   • transition_production_order_status :
--     quand p_status = 'in_progress', vérifie composants.stock >= sr.quantity
--     pour chaque réservation active de l'OF
--     → retourne success:false si insuffisant (cohérent avec le pattern existant)
-- ============================================================


-- ── 1. Nouveau champ : indicateur de planification (snapshot) ─────────────
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS can_start_now boolean DEFAULT NULL;

COMMENT ON COLUMN public.production_orders.can_start_now IS
  'Snapshot de faisabilité stock au moment de la création de l''OF. '
  'true = stock complet, false = déficit constaté à la création, '
  'NULL = OF créé avant cette migration (inconnu, traité comme true dans l''UI). '
  'N''est PAS mis à jour après création — utiliser la garde in_progress pour la vérité d''exécution.';


-- ── 2. Modifier create_production_order_atomic ───────────────────────────
--    Remplace la version de 20260521_c_stock_architecture_v2.sql

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
  v_order_id        uuid;
  v_reference       text;
  v_inserted        integer;
  v_need            record;
  v_available       integer;
  v_can_start_now   boolean := true;
  v_missing_details jsonb   := '[]'::jsonb;
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
    SELECT poi.order_id, po.reference, po.can_start_now
    INTO   v_order_id, v_reference, v_can_start_now
    FROM   public.production_order_idempotency poi
    LEFT JOIN public.production_orders po ON po.id = poi.order_id
    WHERE  poi.idempotency_key = p_idempotency_key;

    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success',            true,
        'order_id',           v_order_id,
        'reference',          v_reference,
        'can_start_now',      v_can_start_now,
        'missing_components', '[]'::jsonb,
        'idempotent_replay',  true
      );
    END IF;
    RAISE EXCEPTION 'idempotency key conflict: %', p_idempotency_key;
  END IF;

  -- ── Vérifications métier bloquantes ──────────────────────────────────
  -- (ces contrôles restent des RAISE EXCEPTION : ils indiquent une incohérence
  --  de configuration, pas un manque de stock temporaire)
  IF NOT EXISTS (
    SELECT 1 FROM public.coffrets
    WHERE id = p_coffret_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'coffret not found or archived: %', p_coffret_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nomenclatures
    WHERE coffret_id = p_coffret_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'no active BOM lines found for coffret %', p_coffret_id;
  END IF;

  -- ── Verrouillage anti-race condition ──────────────────────────────────
  -- Maintenu : empêche deux OFs de réserver le même stock simultanément.
  PERFORM 1
  FROM public.composants c
  JOIN public.nomenclatures n ON n.composant_id = c.id
  WHERE n.coffret_id = p_coffret_id
    AND n.is_active = true
  ORDER BY c.id
  FOR UPDATE;

  -- ── Évaluation de faisabilité (consultative, non bloquante) ──────────
  -- Collecte les composants en déficit sans bloquer la création.
  FOR v_need IN
    SELECT
      n.composant_id,
      (n.quantity * p_quantity)::integer AS qty_needed
    FROM public.nomenclatures n
    WHERE n.coffret_id = p_coffret_id
      AND n.is_active = true
  LOOP
    SELECT GREATEST(0,
      COALESCE(c.stock, 0) - COALESCE(c.reserved_stock, 0)
    )::integer
    INTO v_available
    FROM public.composants c
    WHERE c.id = v_need.composant_id;

    IF COALESCE(v_available, 0) < v_need.qty_needed THEN
      v_can_start_now   := false;
      v_missing_details := v_missing_details || jsonb_build_object(
        'composant_id', v_need.composant_id,
        'needed',       v_need.qty_needed,
        'available',    COALESCE(v_available, 0),
        'missing',      v_need.qty_needed - COALESCE(v_available, 0)
      );
    END IF;
  END LOOP;

  -- ── Création de l'ordre ───────────────────────────────────────────────
  INSERT INTO public.production_orders (
    coffret_id, quantity, status, priority, notes, can_start_now
  )
  VALUES (
    p_coffret_id,
    p_quantity,
    p_status::public.production_status,
    p_priority,
    p_notes,
    v_can_start_now
  )
  RETURNING id, reference INTO v_order_id, v_reference;

  -- ── Réservation du stock (trigger → reserved_stock) ──────────────────
  -- Les réservations sont créées même en cas de déficit :
  -- reserved_stock peut temporairement dépasser stock (rupture visible dans /stock).
  INSERT INTO public.stock_reservations (
    composant_id, quantity, production_order_id, status
  )
  SELECT
    n.composant_id,
    (n.quantity * p_quantity)::integer,
    v_order_id,
    'active'
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id
    AND n.is_active = true;

  -- ── Audit BOM prévisionnel ────────────────────────────────────────────
  INSERT INTO public.production_consumption (
    production_order_id, composant_id, quantity
  )
  SELECT
    v_order_id,
    n.composant_id,
    (n.quantity * p_quantity)::integer
  FROM public.nomenclatures n
  WHERE n.coffret_id = p_coffret_id
    AND n.is_active = true
  ON CONFLICT (production_order_id, composant_id) DO NOTHING;

  -- ── Finalisation idempotency ──────────────────────────────────────────
  UPDATE public.production_order_idempotency
  SET order_id = v_order_id
  WHERE idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'success',            true,
    'order_id',           v_order_id,
    'reference',          v_reference,
    'coffret_id',         p_coffret_id,
    'quantity',           p_quantity,
    'status',             p_status,
    'priority',           p_priority,
    'can_start_now',      v_can_start_now,
    'missing_components', v_missing_details,
    'idempotent_replay',  false
  );
END;
$$;


-- ── 3. Modifier transition_production_order_status (garde P0.3) ──────────
--    Remplace la version de 20260521_c_stock_architecture_v2.sql
--    (avec le correctif de surcharge de 20260521_h_fix_transition_overload.sql)

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
  v_order          public.production_orders%ROWTYPE;
  v_canonical      public.production_status;
  -- P0.3 : vérification stock avant in_progress
  v_missing_count  integer := 0;
  v_missing_list   text    := '';
  v_phys_stock     integer;
  v_sr             record;
BEGIN
  SELECT * INTO v_order
  FROM public.production_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order not found');
  END IF;

  -- Valider le statut cible
  IF p_status NOT IN ('draft', 'priority', 'in_progress', 'partial', 'done') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid status (allowed: draft, priority, in_progress, partial, done)'
    );
  END IF;

  -- États terminaux : aucune transition possible
  IF v_order.status::text IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot transition from terminal status ' || v_order.status::text
    );
  END IF;

  -- ── P0.3 : garde stock physique avant passage en in_progress ─────────
  -- Vérifie que le stock physique (composants.stock) couvre chaque
  -- réservation active de cet OF. C'est la vérité d'exécution :
  -- can_start_now est un snapshot de planification, cette garde est
  -- la source de vérité au moment du démarrage réel.
  IF p_status = 'in_progress' THEN
    FOR v_sr IN
      SELECT
        sr.composant_id,
        sr.quantity                                  AS reserved_qty,
        COALESCE(c.reference, c.id::text)            AS ref,
        COALESCE(c.name, '')                         AS nom
      FROM   public.stock_reservations sr
      JOIN   public.composants c ON c.id = sr.composant_id
      WHERE  sr.production_order_id = p_order_id
        AND  sr.status = 'active'
    LOOP
      SELECT COALESCE(c.stock, 0)
      INTO   v_phys_stock
      FROM   public.composants c
      WHERE  c.id = v_sr.composant_id;

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
        'error',         'Stock insuffisant pour démarrer — '
                         || v_missing_count::text || ' composant(s) manquant(s) : '
                         || v_missing_list,
        'missing_count', v_missing_count
      );
    END IF;
  END IF;
  -- ── Fin garde P0.3 ────────────────────────────────────────────────────

  v_canonical := p_status::public.production_status;

  UPDATE public.production_orders
  SET
    status     = v_canonical,
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
