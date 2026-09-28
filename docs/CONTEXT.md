# RichesPay - Project Context (read this before every task)

## Product
RichesPay is a multi-tenant payment and SMS gateway. Launch countries: Ghana (GH) and Zambia (ZM). Merchants from any country may sign up. RichesPay connects directly to mobile network operators (MNOs).
Services: collections (mobile money, card), payouts (single and bulk), SMS (single, bulk, OTP), airtime (single and bulk top-ups), hosted checkout, payment links, public REST API, signed webhooks, merchant dashboard, admin back-office.
One platform, many tenants. Each merchant is a tenant. RichesPay staff are super admins using a separate admin app.
Products are switched on per merchant: collections, payouts, sms, airtime. A merchant may use any combination of them. SMS clients may only broadcast from the dashboard, only trigger messages from their own app through the API, or both. Airtime merchants send mobile airtime from the dashboard or through the API.

## Stack
- Monorepo: pnpm workspaces + Turborepo.
- apps/api: Node.js (current LTS), TypeScript strict, Fastify, Zod with fastify-type-provider-zod, BullMQ + Redis, Pino logging.
- apps/dashboard: merchant app. React + TypeScript + Vite, Tailwind CSS, TanStack Query, TanStack Table, React Router.
- apps/admin: RichesPay back-office. Same stack, separate build and domain.
- apps/checkout: hosted checkout and payment-link pages. Same stack.
- packages/shared: shared types, Zod schemas, money utilities, error codes.
- packages/ui: RichesPay design system components.
- Database: Supabase Postgres. SQL migrations in supabase/migrations via Supabase CLI. Supabase Auth for dashboard and admin logins.

## Non-negotiable rules
1. Money is always an integer in minor units (bigint) plus an ISO 4217 currency code. Never use floats for money.
2. Every balance change goes through the ledger service as a balanced double-entry journal. Never update a balance column directly.
3. Every endpoint that moves money or sends SMS requires an Idempotency-Key header.
4. Every tenant table has merchant_id. Every query is scoped by merchant_id. Row Level Security is enabled on every table.
5. Browser apps never query Supabase tables. They call apps/api only. The Supabase service role key exists only in apps/api.
6. MNOs, SMS routes and card acquirers are called only through adapters in apps/api/src/providers. Business code never imports a specific provider.
7. Never log or store full card numbers, CVV, PINs, OTP codes or API secrets. Mask phone numbers and emails in logs.
8. Environment variables are validated with Zod at startup. Provider credentials are encrypted at rest with AES-256-GCM.
9. Transaction status changes follow the defined state machine and are recorded in transaction_events.
10. Every admin action writes to audit_logs: actor, action, target, before, after, ip, reason.
11. A merchant has two independent freezes: collections_frozen and payouts_frozen. Check them before every collection and every payout. A suspended merchant can do nothing.
12. Test mode and live mode are fully separated. Every record has mode = 'test' or 'live'. Test keys only ever reach the simulator provider, never a real MNO.
13. Store all times as timestamptz in UTC. Display them in the merchant's timezone.
14. Every product endpoint (collections, payouts, sms, airtime) checks that the product is active for the merchant; otherwise return product_not_enabled. Never build a screen, onboarding step or requirement that assumes a merchant uses every product.

## Currency rules
- Settlement currency is fixed at onboarding by country: GH = GHS, ZM = ZMW, any other country = USD. It can never change.
- Mobile money is always charged in the local currency of the wallet's country.
- Cards may be charged in another presentment currency. Store presentment_amount, presentment_currency, fx_rate, fx_rate_id and settlement_amount on the transaction.
- The dashboard always shows amounts in the merchant's settlement currency.

## API design rules
- Base path /v1. JSON only. snake_case field names.
- Auth header: Authorization: Bearer <secret key>. Secret keys look like rp_test_sk_... or rp_live_sk_.... Public keys (rp_test_pk_, rp_live_pk_) are only for hosted checkout.
- Resource IDs are prefixed ULIDs: col_ (collection), pay_ (payout), bat_ (payout batch), sms_ (message), smb_ (SMS batch), air_ (airtime order), aib_ (airtime batch), lnk_ (payment link), whe_ (webhook endpoint), evt_ (event), cus_ (customer).
- Success response: { "data": ..., "meta": {...} }. Error response: { "error": { "code", "message", "field", "request_id" } }.
- Cursor pagination: ?limit=20&starting_after=<id>.
- Amount fields: "amount": 1500, "currency": "GHS" means GHS 15.00.
- Every response carries an X-Request-Id header.
- Webhooks are signed with header RichesPay-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">.
- Keep the API small and predictable. One way to do each thing.

## UI rules
- Brand name RichesPay. White is the dominant colour. Orange is the primary accent. Neutral greys for text and borders.
- Font Inter. Tabular numbers for amounts.
- Every list page uses the same layout: page title with at most one primary button, a row of 3 or 4 summary cards, a filter bar (search plus at most 3 filters), a data table with pagination, and a side drawer for row details.
- No clutter. Clear empty states with one action. Skeleton loaders, not spinners, for tables.
- Format all money through formatMoney from packages/shared.

## Launch channels
- Ghana mobile money: MTN MoMo, Telecel Cash, AT Money.
- Zambia mobile money: MTN MoMo, Airtel Money, Zamtel mobile money.
- SMS: direct MNO routes (SMPP or HTTP). Several routes per country with failover.
- Airtime: direct MNO airtime vending. Ghana: MTN, Telecel, AT. Zambia: MTN, Airtel, Zamtel. An optional aggregator channel acts as backup.
- Cards: one generic card-acquirer adapter interface. Hosted fields or redirect plus 3-D Secure. RichesPay never stores card numbers.

## Definition of done for every task
- pnpm typecheck, pnpm lint and pnpm test pass.
- New endpoints appear in the generated OpenAPI spec.
- New tables have migrations, RLS policies and indexes on merchant_id and created_at.
- A short entry is added to docs/CHANGELOG.md.
