-- ============================================================
-- MIGRATION N : Renommer old_priority → priority dans l'enum
--
-- L'enum avait 'priority' à l'origine, renommé en 'old_priority'
-- par une migration intermédiaire. On le restaure.
-- Les RPCs et le frontend utilisent 'priority' comme valeur canonique.
-- ============================================================

ALTER TYPE public.production_status RENAME VALUE 'old_priority' TO 'priority';
