-- ============================================================
-- MIGRATION M : Partial Stock Allocation (ERP behavior)
--
-- Lors du lancement (draft → in_progress) :
--   • Calcule qty_possible = min(floor(stock_physique / bom_par_unité))
--   • Si qty_possible == 0            → pending_material (existant)
--   • Si qty_possible >= quantity     → in_progress (existant)
--   • Si 0 < qty_possible < quantity  → SPLIT :
--       - OF original : quantity réduit à qty_possible → in_progress
--       - Nouvel OF    : quantity = reste → pending_material (avec réservations déficitaires)
--       - Retourne { split: true, qty_launched, qty_pending, split_order_id, split_reference }
-- ============================================================

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
  v_final_status   public.production_status;
  v_missing_count  integer := 0;
  v_missing_list   text    := '';
  v_phys_stock     integer;
  v_sr             record;
  v_need           record;
  -- Partial allocation
  v_qty_possible   integer;
  v_min_possible   integer := NULL;
  v_bom_per_unit   integer;
  v_avail          integer;
  -- Split OF
  v_split_id       uuid;
  v_split_ref      text;
  v_qty_remaining  integer;
  v_has_reserv     boolean;
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
    RETURN jsonb_build_object('success', false, 'error', 'invalid status');
  END IF;

  -- États terminaux
  IF v_order.status::text IN ('done', 'termine', 'canceled', 'annule') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot transition from terminal status ' || v_order.status::text
    );
  END IF;

  -- ── LANCEMENT : draft / priority → in_progress ───────────────────────
  IF p_status = 'in_progress'
     AND v_order.status::text IN ('draft', 'priority')
  THEN
    -- Verrouillage anti-race condition
    PERFORM 1
    FROM public.composants c
    JOIN public.nomenclatures n ON n.composant_id = c.id
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    ORDER BY c.id
    FOR UPDATE;

    -- ── Calcul de qty_possible (min sur tous les composants) ─────────────
    FOR v_need IN
      SELECT
        n.composant_id,
        n.quantity AS bom_per_unit
      FROM public.nomenclatures n
      WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    LOOP
      SELECT GREATEST(0, COALESCE(c.stock, 0))
      INTO v_avail
      FROM public.composants c
      WHERE c.id = v_need.composant_id;

      -- floor(dispo / besoin_par_unité) = max coffrets productibles avec ce composant
      IF v_need.bom_per_unit > 0 THEN
        v_qty_possible := FLOOR(v_avail::numeric / v_need.bom_per_unit)::integer;
      ELSE
        v_qty_possible := v_order.quantity; -- composant sans besoin (rare)
      END IF;

      IF v_min_possible IS NULL OR v_qty_possible < v_min_possible THEN
        v_min_possible := v_qty_possible;
      END IF;
    END LOOP;

    -- Fallback si BOM vide (ne devrait pas arriver — validation création)
    IF v_min_possible IS NULL THEN
      v_min_possible := 0;
    END IF;

    -- ── CAS 1 : stock zéro → tout en pending_material ────────────────────
    IF v_min_possible = 0 THEN
      -- Créer les réservations déficitaires si pas encore faites
      SELECT EXISTS (
        SELECT 1 FROM public.stock_reservations
        WHERE production_order_id = p_order_id AND status = 'active'
      ) INTO v_has_reserv;

      IF NOT v_has_reserv THEN
        INSERT INTO public.stock_reservations (composant_id, quantity, production_order_id, status)
        SELECT n.composant_id, (n.quantity * v_order.quantity)::integer, p_order_id, 'active'
        FROM public.nomenclatures n
        WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true;

        INSERT INTO public.production_consumption (production_order_id, composant_id, quantity)
        SELECT p_order_id, n.composant_id, (n.quantity * v_order.quantity)::integer
        FROM public.nomenclatures n
        WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
        ON CONFLICT (production_order_id, composant_id) DO NOTHING;
      END IF;

      UPDATE public.production_orders
      SET status = 'pending_material'::public.production_status, can_start_now = false,
          priority = COALESCE(p_priority, priority), updated_at = now()
      WHERE id = p_order_id;

      RETURN jsonb_build_object(
        'success', true, 'order_id', p_order_id,
        'status', 'pending_material', 'split', false,
        'qty_launched', 0, 'qty_pending', v_order.quantity
      );
    END IF;

    -- ── CAS 2 : stock suffisant pour tout → in_progress ──────────────────
    IF v_min_possible >= v_order.quantity THEN
      -- Réservations pour la quantité totale
      SELECT EXISTS (
        SELECT 1 FROM public.stock_reservations
        WHERE production_order_id = p_order_id AND status = 'active'
      ) INTO v_has_reserv;

      IF NOT v_has_reserv THEN
        INSERT INTO public.stock_reservations (composant_id, quantity, production_order_id, status)
        SELECT n.composant_id, (n.quantity * v_order.quantity)::integer, p_order_id, 'active'
        FROM public.nomenclatures n
        WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true;

        INSERT INTO public.production_consumption (production_order_id, composant_id, quantity)
        SELECT p_order_id, n.composant_id, (n.quantity * v_order.quantity)::integer
        FROM public.nomenclatures n
        WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
        ON CONFLICT (production_order_id, composant_id) DO NOTHING;
      END IF;

      UPDATE public.production_orders
      SET status = 'in_progress'::public.production_status, can_start_now = true,
          priority = COALESCE(p_priority, priority), updated_at = now()
      WHERE id = p_order_id;

      RETURN jsonb_build_object(
        'success', true, 'order_id', p_order_id,
        'status', 'in_progress', 'split', false,
        'qty_launched', v_order.quantity, 'qty_pending', 0
      );
    END IF;

    -- ── CAS 3 : stock partiel → SPLIT ────────────────────────────────────
    -- v_min_possible coffrets → in_progress
    -- v_order.quantity - v_min_possible → pending_material (nouvel OF)
    v_qty_remaining := v_order.quantity - v_min_possible;

    -- Réservations pour la partie lancée (qty = v_min_possible)
    INSERT INTO public.stock_reservations (composant_id, quantity, production_order_id, status)
    SELECT n.composant_id, (n.quantity * v_min_possible)::integer, p_order_id, 'active'
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true;

    -- BOM prévisionnel de la partie lancée
    INSERT INTO public.production_consumption (production_order_id, composant_id, quantity)
    SELECT p_order_id, n.composant_id, (n.quantity * v_min_possible)::integer
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    ON CONFLICT (production_order_id, composant_id) DO UPDATE
      SET quantity = EXCLUDED.quantity;

    -- Mise à jour OF original : quantity réduit + in_progress
    UPDATE public.production_orders
    SET quantity = v_min_possible,
        status   = 'in_progress'::public.production_status,
        can_start_now = true,
        priority = COALESCE(p_priority, priority),
        updated_at = now()
    WHERE id = p_order_id;

    -- Création du nouvel OF pour la partie restante (pending_material)
    INSERT INTO public.production_orders (
      coffret_id, quantity, status, priority, notes,
      client_of_reference, can_start_now
    )
    VALUES (
      v_order.coffret_id, v_qty_remaining,
      'pending_material'::public.production_status,
      COALESCE(p_priority, v_order.priority),
      v_order.notes,
      v_order.client_of_reference,
      false
    )
    RETURNING id, reference INTO v_split_id, v_split_ref;

    -- Réservations déficitaires pour le nouvel OF
    INSERT INTO public.stock_reservations (composant_id, quantity, production_order_id, status)
    SELECT n.composant_id, (n.quantity * v_qty_remaining)::integer, v_split_id, 'active'
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true;

    -- BOM prévisionnel de la partie restante
    INSERT INTO public.production_consumption (production_order_id, composant_id, quantity)
    SELECT v_split_id, n.composant_id, (n.quantity * v_qty_remaining)::integer
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    ON CONFLICT (production_order_id, composant_id) DO NOTHING;

    RETURN jsonb_build_object(
      'success',         true,
      'order_id',        p_order_id,
      'status',          'in_progress',
      'split',           true,
      'qty_launched',    v_min_possible,
      'qty_pending',     v_qty_remaining,
      'split_order_id',  v_split_id,
      'split_reference', v_split_ref
    );
  END IF;

  -- ── RELANCE : pending_material → in_progress ─────────────────────────
  -- Même logique de split, mais on modifie cet OF pending_material.
  IF p_status = 'in_progress' AND v_order.status::text = 'pending_material' THEN
    -- Verrouillage
    PERFORM 1
    FROM public.composants c
    JOIN public.nomenclatures n ON n.composant_id = c.id
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    ORDER BY c.id
    FOR UPDATE;

    -- Calcul qty_possible en tenant compte des réservations existantes de CET OF
    -- (elles sont déjà dans stock via reserved_stock ; on repart du physique brut)
    FOR v_need IN
      SELECT n.composant_id, n.quantity AS bom_per_unit
      FROM public.nomenclatures n
      WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    LOOP
      -- Stock physique + ce que cet OF avait réservé (car si on relance on peut récupérer)
      SELECT GREATEST(0,
          COALESCE(c.stock, 0)
          + COALESCE((
              SELECT sr.quantity FROM public.stock_reservations sr
              WHERE sr.production_order_id = p_order_id
                AND sr.composant_id = v_need.composant_id
                AND sr.status = 'active'
              LIMIT 1
          ), 0)
      )
      INTO v_avail
      FROM public.composants c
      WHERE c.id = v_need.composant_id;

      IF v_need.bom_per_unit > 0 THEN
        v_qty_possible := FLOOR(v_avail::numeric / v_need.bom_per_unit)::integer;
      ELSE
        v_qty_possible := v_order.quantity;
      END IF;

      IF v_min_possible IS NULL OR v_qty_possible < v_min_possible THEN
        v_min_possible := v_qty_possible;
      END IF;
    END LOOP;

    IF v_min_possible IS NULL THEN v_min_possible := 0; END IF;

    -- Toujours bloqué
    IF v_min_possible = 0 THEN
      -- Construire liste des manquants
      FOR v_sr IN
        SELECT sr.composant_id, sr.quantity AS reserved_qty,
               COALESCE(c.reference, c.id::text) AS ref
        FROM public.stock_reservations sr
        JOIN public.composants c ON c.id = sr.composant_id
        WHERE sr.production_order_id = p_order_id AND sr.status = 'active'
      LOOP
        SELECT COALESCE(c.stock, 0) INTO v_phys_stock
        FROM public.composants c WHERE c.id = v_sr.composant_id;
        IF v_phys_stock < v_sr.reserved_qty THEN
          v_missing_count := v_missing_count + 1;
          v_missing_list  := v_missing_list
            || CASE WHEN v_missing_list <> '' THEN ', ' ELSE '' END
            || v_sr.ref || ' (manque ' || (v_sr.reserved_qty - v_phys_stock)::text || ')';
        END IF;
      END LOOP;
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Il manque encore des pièces : ' || v_missing_list,
        'missing_count', v_missing_count
      );
    END IF;

    -- Peut tout produire
    IF v_min_possible >= v_order.quantity THEN
      -- Mettre à jour les réservations existantes si elles sont inférieures
      UPDATE public.stock_reservations sr
      SET quantity = (n.quantity * v_order.quantity)::integer, updated_at = now()
      FROM public.nomenclatures n
      WHERE sr.production_order_id = p_order_id
        AND sr.composant_id = n.composant_id
        AND n.coffret_id = v_order.coffret_id
        AND sr.status = 'active';

      UPDATE public.production_orders
      SET status = 'in_progress'::public.production_status, can_start_now = true,
          priority = COALESCE(p_priority, priority), updated_at = now()
      WHERE id = p_order_id;

      RETURN jsonb_build_object(
        'success', true, 'order_id', p_order_id,
        'status', 'in_progress', 'split', false,
        'qty_launched', v_order.quantity, 'qty_pending', 0
      );
    END IF;

    -- Split depuis pending_material
    v_qty_remaining := v_order.quantity - v_min_possible;

    -- Ajuster réservations existantes pour la partie lancée
    UPDATE public.stock_reservations sr
    SET quantity = (n.quantity * v_min_possible)::integer, updated_at = now()
    FROM public.nomenclatures n
    WHERE sr.production_order_id = p_order_id
      AND sr.composant_id = n.composant_id
      AND n.coffret_id = v_order.coffret_id
      AND sr.status = 'active';

    UPDATE public.production_orders
    SET quantity = v_min_possible, status = 'in_progress'::public.production_status,
        can_start_now = true, priority = COALESCE(p_priority, priority), updated_at = now()
    WHERE id = p_order_id;

    -- Nouvel OF pour le reste
    INSERT INTO public.production_orders (
      coffret_id, quantity, status, priority, notes,
      client_of_reference, can_start_now
    )
    VALUES (
      v_order.coffret_id, v_qty_remaining,
      'pending_material'::public.production_status,
      COALESCE(p_priority, v_order.priority),
      v_order.notes, v_order.client_of_reference, false
    )
    RETURNING id, reference INTO v_split_id, v_split_ref;

    INSERT INTO public.stock_reservations (composant_id, quantity, production_order_id, status)
    SELECT n.composant_id, (n.quantity * v_qty_remaining)::integer, v_split_id, 'active'
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true;

    INSERT INTO public.production_consumption (production_order_id, composant_id, quantity)
    SELECT v_split_id, n.composant_id, (n.quantity * v_qty_remaining)::integer
    FROM public.nomenclatures n
    WHERE n.coffret_id = v_order.coffret_id AND n.is_active = true
    ON CONFLICT (production_order_id, composant_id) DO NOTHING;

    RETURN jsonb_build_object(
      'success', true, 'order_id', p_order_id,
      'status', 'in_progress', 'split', true,
      'qty_launched', v_min_possible, 'qty_pending', v_qty_remaining,
      'split_order_id', v_split_id, 'split_reference', v_split_ref
    );
  END IF;

  -- ── TRANSITION STANDARD ───────────────────────────────────────────────
  v_final_status := p_status::public.production_status;

  UPDATE public.production_orders
  SET status = v_final_status, priority = COALESCE(p_priority, priority), updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true, 'order_id', p_order_id,
    'status', p_status, 'priority', COALESCE(p_priority, v_order.priority)
  );
END;
$$;
