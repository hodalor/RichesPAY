# Webhooks

When a collection, payout, SMS, or airtime order finishes, RichesPay sends a POST to the webhook URL you registered. You do not poll for the final status.

## Endpoint requirements

Your webhook URL must:

- Be publicly reachable
- Accept POST requests with a JSON body
- Respond with HTTP `200`

## Sample payload

```json
{
  "id": "evt_...",
  "type": "airtime.successful",
  "created_at": "2026-09-28T06:11:39.000Z",
  "mode": "live",
  "data": {
    "airtime_id": "air_...",
    "status": "successful",
    "phone": "+260970000001",
    "network": "MTN",
    "amount": 1000,
    "currency": "ZMW",
    "reference": "REWARD-221"
  }
}
```

Header: `RichesPay-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. Verify that signature on the raw body before you parse JSON.

## Fields

| Field | Description |
| --- | --- |
| `id` | Event id (`evt_...`) |
| `type` | What happened, for example `collection.successful` or `airtime.failed` |
| `created_at` | UTC timestamp |
| `mode` | `test` or `live` |
| `data` | The resource. Match `reference` or the resource id to your original request |

## What to do

| type | Action |
| --- | --- |
| `collection.successful`, `payout.successful`, `airtime.successful` | Fulfil the order |
| `*.failed` | Stop and notify the customer |
| `airtime_batch.completed` | The bulk run finished |

## Missed webhooks

If your system misses a POST, GET the resource (`/v1/collections/:id`, `/v1/payouts/:id`, `/v1/airtime/:id`) and treat that status the same way.
