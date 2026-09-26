# Changelog

## 2026-09-26
- Scaffolded the initial RichesPay monorepo with API, dashboard, admin, checkout, shared packages, UI package wiring, local Redis, and Supabase project structure.
- Built the RichesPay design system in `packages/ui`, exported the shared Tailwind preset and theme variables, and added the dashboard `/ui-kit` sample list page.
- Added the first RichesPay core schema, Kysely database layer, merchant/system scoped DB helpers, RLS policies, local seed data, and a real isolation test proving tenant boundaries hold even without a `WHERE merchant_id = ...` clause.
- Added the ledger schema, DB-enforced balance invariants, typed `LedgerService`, nightly balance verification, and integration coverage for unbalanced entries, currency mixing, insufficient funds, and parallel payout holds.
- Added Supabase-based dashboard and admin authentication, MFA-aware access control plugins, merchant role permissions, team invitation flows, and auth coverage for MFA and admin IP allowlist enforcement.
