# Testing Guide

## Simulator Mobile Money Numbers

Test-mode mobile money traffic uses the simulator provider. The simulator behavior is determined by the phone number ending:

| Ending | Submit behavior | Follow-up behavior |
| --- | --- | --- |
| `0001` | Accepted immediately | Callback succeeds after 5 seconds |
| `0002` | Fails immediately | `insufficient_funds` |
| `0003` | Accepted and stays pending | No callback; `getStatus()` succeeds later |
| `0004` | Fails immediately | Provider status is `customer_declined` |
| `0005` | Times out | Outcome is unknown on submit, then `getStatus()` succeeds |
| Any other suffix | Accepted immediately | Callback succeeds after 3 seconds |

## Simulator Card Numbers

Test-mode card collections use the simulator card acquirer through the generic `CardAcquirer` interface. Card data stays inside the hosted iframe page and callbacks contain masked card details only.

| Card number | Submit behavior | Follow-up behavior |
| --- | --- | --- |
| `4000000000000001` | Accepted immediately | Callback marks the collection successful |
| `4000000000000002` | Accepted by the iframe | Callback marks the collection declined |
| `4000000000000003` | Accepted by the iframe | Shows a 3-D Secure challenge, then callback marks the collection successful after approval |

## Simulator Bank Payout Accounts

Test-mode bank payouts use the simulator `BankPayoutProvider` through the generic bank payout channel.

| Account number ending | Submit behavior | Follow-up behavior |
| --- | --- | --- |
| `0001` | Accepted immediately | Treated as a normal successful bank payout |
| `0002` | Fails immediately | `insufficient_funds` |
| `0003` | Accepted and stays pending | No callback; `getStatus()` succeeds later |
| `0004` | Fails immediately | Provider status is `account_rejected` |
| `0005` | Times out | Outcome is unknown on submit, then `getStatus()` succeeds |
| Any other suffix | Accepted immediately | Treated as a normal successful bank payout |

## Simulator SMS Numbers

Test-mode SMS traffic uses the simulator `SmsProvider`. The simulator behavior is determined by the destination number ending:

| Ending | Submit behavior | Delivery report outcome |
| --- | --- | --- |
| `0001` | Accepted immediately | `delivered` |
| `0002` | Accepted immediately | `undelivered` |
| `0003` | Fails immediately | `rejected` |
| Any other suffix | Accepted immediately | `delivered` |

## Top-Ups In Test Mode

- Dashboard merchants can use **Add test funds** to credit `merchant_available` instantly without going through a provider.
- Mobile-money top-ups reuse the simulator mobile-money behavior table above and settle into the same balance used for payouts and SMS.
- Bank-transfer top-ups show the merchant's `RPTOP-...` transfer reference and require statement import or admin confirmation before funds are credited.
