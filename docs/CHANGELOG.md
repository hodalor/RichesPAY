# Changelog

## 2026-09-27
- Added merchant webhook endpoint management and outbox delivery with encrypted `whsec_` secrets, signed payload delivery attempts, retry backoff, SSRF protections, replay and test-send dashboard endpoints, and delivery audit storage for merchant systems.
- Added webhook delivery verification docs in `docs/webhooks.md`, plus auto-disable and merchant email alerts after repeated endpoint failures.
- Added compliance controls for merchant collections, payouts, and suspension states with audited admin freeze/reactivate endpoints, dashboard read-only banners, merchant freeze history, and outbox events for freeze and unfreeze actions.
- Added merchant compliance profiles with KYB-tier limits, collection velocity review flags, screening-provider hooks for onboarding and high-value payouts, rolling reserve holds and release tracking, and focused integration coverage for reserve settlement and payout `on_hold` resume behavior.
- Added merchant balance top-ups with `topups`, merchant transfer references, low-balance alert thresholds, and email/webhook outbox writes, plus ledger-backed credits into `merchant_available` so one balance funds payouts and SMS.
- Reused the collections and checkout engines internally for mobile-money and card top-ups with hidden `reference_type = 'topup'`, added dashboard/admin top-up endpoints and drawer flows, test-mode instant funds, and integration coverage for top-up-funded SMS charging and payouts.
- Added the disbursements foundation with `banks`, `payouts`, and `payout_batches` tables, bank-channel support in the provider framework, payout polling/dispatch loops, callback reconciliation for payouts, public payout endpoints, and dashboard approval/template endpoints for maker-checker workflows.
- Added simulator-backed bank payout behavior, payout hold/complete/release ledger integration, payout outbox events, and public API integration coverage for insufficient balance, frozen payouts, hold release on cancel, and the no-double-send timeout path.
- Added card collections through the generic `CardAcquirer` flow with hosted-fields or redirect next actions, presentment-versus-settlement FX storage, checkout card handling that never posts PAN or CVV to `apps/api`, card and refund events, and a short PCI scope note in `docs/pci.md`.
- Added refund creation on `/v1/collections/:id/refunds`, simulator-backed card callback coverage, masked card-result storage, mobile-money refund permission enforcement, and checkout/public API tests for the card flow.
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
