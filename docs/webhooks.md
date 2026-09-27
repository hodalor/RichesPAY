# Webhooks

RichesPay delivers merchant events to HTTPS webhook endpoints from the event outbox.

## Delivery model

- Header: `RichesPay-Signature: t=<unix>,v1=<hex hmac sha256 of "t.rawBody">`
- Method: `POST`
- Content-Type: `application/json`
- Timeout: `10` seconds
- Redirects: disabled
- Retries: `1m`, `5m`, `30m`, `2h`, `6h`, `12h`, `24h`
- Endpoints are disabled after `20` consecutive failures

## Payload

```json
{
  "id": "evt_01K61B9S6DF4W8M2V9HZ6M8B2C",
  "type": "collection.successful",
  "created_at": "2026-09-27T06:11:39.000Z",
  "mode": "live",
  "data": {
    "collection_id": "col_01K61B9QWQ3TY3BMBTWQ9S4K8A",
    "amount": 1500,
    "currency": "GHS"
  }
}
```

## Verify Signature

### Node.js

```js
import crypto from "node:crypto";

export function verifyRichesPaySignature({ header, rawBody, secret }) {
  if (!header) {
    return false;
  }

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    })
  );

  if (!parts.t || !parts.v1) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(parts.v1, "hex")
  );
}
```

### PHP

```php
<?php

function verify_richespay_signature(string $header, string $rawBody, string $secret): bool
{
    $parts = [];
    foreach (explode(',', $header) as $part) {
        [$key, $value] = array_map('trim', explode('=', $part, 2));
        $parts[$key] = $value;
    }

    if (!isset($parts['t'], $parts['v1'])) {
        return false;
    }

    $expected = hash_hmac('sha256', $parts['t'] . '.' . $rawBody, $secret);

    return hash_equals($expected, $parts['v1']);
}
```

### Python

```python
import hmac
import hashlib


def verify_richespay_signature(header: str, raw_body: str, secret: str) -> bool:
    parts = {}
    for item in header.split(","):
        key, value = item.split("=", 1)
        parts[key.strip()] = value.strip()

    if "t" not in parts or "v1" not in parts:
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        f"{parts['t']}.{raw_body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(expected, parts["v1"])
```

## Notes

- Use the raw request body exactly as RichesPay sent it.
- Verify the signature before parsing JSON.
- Roll the endpoint secret immediately if you suspect it has been exposed.
