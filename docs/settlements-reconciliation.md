# Settlements And Reconciliation

RichesPay now supports merchant withdrawals to admin-verified settlement accounts and daily provider reconciliation for collections and payouts.

## Merchant Settlement Flow

- Merchants create settlement accounts in the dashboard as either `bank` or `mobile_money`.
- Settlement account changes clear any previous verification and apply a `24` hour cool-off window before the account can receive funds.
- Only admin-verified settlement accounts can be used for withdrawals or automatic daily settlement.
- Withdrawals reuse the payout engine and ledger-backed payout hold flow. RichesPay does not maintain a separate withdrawal money path.
- Merchants can enable automatic daily settlement (`T+1`) and choose the settlement account used for that sweep.
- Automatic settlement quotes payout fees first and only withdraws an amount that the merchant can actually cover from `merchant_available`.

## Dashboard Endpoints

- `GET /dashboard/v1/settlement-accounts`
- `POST /dashboard/v1/settlement-accounts`
- `PUT /dashboard/v1/settlement-accounts/:accountId`
- `GET /dashboard/v1/settlement-settings`
- `PUT /dashboard/v1/settlement-settings`
- `GET /dashboard/v1/withdrawals`
- `GET /dashboard/v1/withdrawals/:withdrawalId`
- `POST /dashboard/v1/withdrawals`

These routes require the `settlements.manage` permission.

## Admin Reconciliation Flow

- Provider statements are stored per channel and statement date.
- Statements can be imported from CSV or fetched from a provider adapter that implements `fetchStatement(statementDate)`.
- Each statement line is matched to RichesPay collections or payouts using provider reference, amount, and status.
- RichesPay stores daily summaries per channel covering counts, volumes, fees, exception totals, and whether the provider float matches the internal `provider_clearing` balance.

## Reconciliation Exception Types

- `missing_in_richespay`
- `missing_at_provider`
- `amount_mismatch`
- `status_mismatch`

## Admin Resolution Actions

- `force_status`: after provider confirmation, resolve the exception by driving the existing collection or payout reconciliation path instead of bypassing state machines.
- `manual_adjustment`: post a balanced admin adjustment through `LedgerService.manualAdjustment(...)` with a required reason.
- `dismiss`: close a false-positive or already-handled exception with an audited reason.

## Admin Endpoints

- `POST /admin/v1/settlement-accounts/:accountId/verify`
- `POST /admin/v1/reconciliation/statements/import`
- `POST /admin/v1/reconciliation/statements/fetch`
- `GET /admin/v1/reconciliation/exceptions`
- `POST /admin/v1/reconciliation/exceptions/:exceptionId/resolve-force-status`
- `POST /admin/v1/reconciliation/exceptions/:exceptionId/manual-adjustment`
- `POST /admin/v1/reconciliation/exceptions/:exceptionId/dismiss`
- `GET /admin/v1/reconciliation/summaries`

All admin write actions are audited and require a reason.

## Notes

- Current provider adapters are statement-fetch ready, but most still need provider-specific `fetchStatement(...)` implementations.
- Focused integration coverage lives in `apps/api/test/settlements-reconciliation.test.ts`, including fixtures for each reconciliation exception type.
