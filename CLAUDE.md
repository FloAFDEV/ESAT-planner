# ESAT Palette Planner — directives de développement Claude

## Branche de développement

Travailler **directement sur la branche désignée dans les instructions de session** (`claude/fix-box-inventory-decrement-jptvr` ou toute branche indiquée).

**Ne pas créer de sous-branche par correction ou item P0/P1.** Tout le travail d'une session va sur la branche de travail unique. Une seule PR par session suffit.

## Contraintes métier absolues (à respecter sans exception)

- **NE JAMAIS vider le stock physique** : `composants.stock`, `coffrets.stock_fini`, `mouvements` sont intouchables hors RPC dédiée.
- Les migrations doivent être cumulatives et non-destructives.
- Aucune modification RLS / sécurité globale sans validation explicite (P2 mis en attente).
- Pas de refactor global simultané — une thématique par session.

## Stack technique

- **Frontend** : React + TanStack Router + React Query + Tailwind + shadcn/ui
- **Backend** : Supabase (PostgreSQL, RPCs SECURITY DEFINER, triggers)
- **Migrations** : `supabase/migrations/` — nommage `YYYYMMDD_<lettre>_<slug>.sql`

## Conventions de code

- Pas de commentaires sauf si le WHY est non-évident (contrainte cachée, invariant subtil).
- Pas de gestion d'erreur pour des scénarios impossibles.
- Pas de feature flags ni de shims de compatibilité.
- Pas de nouvelles abstractions sans besoin concret.

## Flux stock / production (règles de gestion clés)

- **Réservation** → à la création de l'OF (`stock_reservations`)
- **Libération** → à l'annulation (RPC `cancel_production_order_with_unreserve`)
- **Consommation** → à la validation (RPC `validate_production_order` → trigger `tg_apply_mouvement` → `composants.stock--`)
- `can_start_now` : snapshot planning à la création, pas une garde d'exécution
- La garde d'exécution réelle est dans `transition_production_order_status` (vérifie `composants.stock >= sr.quantity`)

## Statuts OF (machine à états)

`draft` / `priority` → `in_progress` → `partial` → `done`  
Annulation possible depuis tout état non-terminal → `canceled`  
8 alias legacy normalisés par `normalizeProductionStatus()`.

## Requêtes PostgREST — pièges connus

- Limite par défaut 1000 lignes (silencieuse) → toujours `.limit(N)` explicite sur les listes longues.
- `.in()` sérialisé en GET → HTTP 414 au-delà de ~300 UUIDs → batcher par 100.
- Soft-delete : toujours `.is('deleted_at', null)` sur `composants` et `coffrets`.
