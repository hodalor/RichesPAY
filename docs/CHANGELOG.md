# Changelog

## 2026-09-27
- Added hosted checkout sessions and payment links with RLS-backed `checkout_sessions` and `payment_links` tables, public checkout endpoints, dashboard CRUD, and integration coverage for expiry, single-use links, and the simulator-backed end-to-end payment flow.
- Replaced the checkout app placeholder with the hosted checkout and payment-link experience, including mobile money network selection, live polling status screens, success and failure return states, and an embeddable `richespay.js` iframe launcher.

## 2026-09-26
- Scaffolded the initial RichesPay monorepo with API, dashboard, admin, checkout, shared packages, UI package wiring, local Redis, and Supabase project structure.
- Built the RichesPay design system in `packages/ui`, exported the shared Tailwind preset and theme variables, and added the dashboard `/ui-kit` sample list page.
- Added the first RichesPay core schema, Kysely database layer, merchant/system scoped DB helpers, RLS policies, local seed data, and a real isolation test proving tenant boundaries hold even without a `WHERE merchant_id = ...` clause.
- Added the ledger schema, DB-enforced balance invariants, typed `LedgerService`, nightly balance verification, and integration coverage for unbalanced entries, currency mixing, insufficient funds, and parallel payout holds.
- Added Supabase-based dashboard and admin authentication, MFA-aware access control plugins, merchant role permissions, team invitation flows, and auth coverage for MFA and admin IP allowlist enforcement.
- Added the public `/v1` API core with API key management, Bearer key auth, idempotency storage and replay handling, request logging, transaction events, `/v1/balance`, and integration coverage for key rejection and replay behavior.
- Added the provider channel framework with encrypted channel credentials, routing rules, circuit breaking, callback inbox processing, provider API logging, admin channel management routes, and tests for routing, failover, and no-double-submit safeguards.
- Added the simulator mobile money behavior table, shared mobile money adapter contract tests, E.164 phone validation, and provider adapter folders for MTN MoMo, Telecel Cash, AT Money, Airtel Money, and Zamtel Money with explicit TODO(spec) placeholders where provider documentation is still missing.
- Added pricing and FX support with fee plans, merchant pricing overrides, SMS price storage, manual FX rates, a public `/v1/fees/quote` endpoint, and coverage for fee caps, fee-bearer rounding, and FX conversion rounding.
- Added the mobile money collections API with collection storage, status-state enforcement, event outbox writes, simulator-backed collection creation and retrieval endpoints, and polling-based settlement into the ledger using gross/net/fee postings.
