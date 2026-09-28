# Airtime API

Merchants send mobile airtime as a face-value top-up. The recipient is always charged in the local currency of the phone's country. RichesPay charges the merchant in its settlement currency: face value minus the network discount, converted with the current FX rate when those currencies differ.

Airtime is a product. The API key needs the `airtime` scope, and the merchant must have airtime enabled. Otherwise the API returns `product_not_enabled`.

Every `POST` requires an `Idempotency-Key` header.

## Send airtime

```bash
curl https://api.richespay.com/v1/airtime \
  -H "Authorization: Bearer rp_test_sk_..." \
  -H "Idempotency-Key: reward-221" \
  -d '{"phone":"+260970000001","amount":1000,"currency":"ZMW","reference":"REWARD-221"}'
```

Response:

```json
{
  "data": {
    "id": "air_...",
    "status": "pending",
    "phone": "+260970000001",
    "network": "MTN",
    "amount": 1000,
    "currency": "ZMW",
    "charge_amount": 970,
    "charge_currency": "ZMW",
    "reference": "REWARD-221",
    "created_at": "2026-09-28T00:00:00.000Z"
  }
}
```

`amount` is the face value in minor units (ZMW 10.00). `charge_amount` is what the merchant pays after the discount. `network` is optional on the request; when omitted, RichesPay detects it from the phone number.

Checks run in this order: merchant active, airtime product active, valid number, network supported, amount allowed, available balance, per-number daily limits.

## Quote and networks

```bash
curl "https://api.richespay.com/v1/airtime/networks?country=ZM" \
  -H "Authorization: Bearer rp_test_sk_..."

curl "https://api.richespay.com/v1/airtime/quote?phone=%2B260970000001&amount=1000&currency=ZMW" \
  -H "Authorization: Bearer rp_test_sk_..."
```

Networks include min, max, optional fixed denominations, and the merchant's discount in basis points.

## Bulk

Send either a list of items or one amount to many phones. A batch accepts at most 5,000 recipients.

```bash
curl https://api.richespay.com/v1/airtime/bulk \
  -H "Authorization: Bearer rp_test_sk_..." \
  -H "Idempotency-Key: rewards-sep" \
  -d '{"phones":["+260970000001","+260960000001"],"amount":1000,"currency":"ZMW"}'
```

The response is the batch (`aib_...`) with `accepted`, `rejected`, and `rejected_rows` (index, phone, code, message). Retrieve it later with `GET /v1/airtime/batches/:id`.

## Retrieve

- `GET /v1/airtime/:id`
- `GET /v1/airtime` filters: `status`, `phone`, `batch_id`, `created_gte`, `created_lte`, cursor pagination
- `GET /v1/airtime/batches/:id`

Statuses: `pending`, `processing`, `successful`, `failed`.

## Errors

| Code | When |
| --- | --- |
| `product_not_enabled` | Airtime is off for the merchant |
| `invalid_phone_number` | The number is not a valid mobile MSISDN |
| `network_not_supported` | The detected or requested network is not sold |
| `amount_not_allowed` | Outside the network min/max or not a fixed denomination |
| `insufficient_funds` | Available balance cannot cover `charge_amount` |
| `airtime_unavailable` | No channel with float can accept the order |

## Events

Signed webhooks: `airtime.successful`, `airtime.failed`, `airtime_batch.completed`.

## Test numbers

In test mode the simulator is the only channel.

| Number ending | Result |
| --- | --- |
| `0001` | Successful |
| `0002` | Failed `invalid_phone_number` |
| `0003` | Pending, then successful on status check |
| `0004` | Failed `airtime_unavailable` |
| `0005` | Timeout (unknown). The order stays `processing` and is never resent; a later status check marks it successful |
