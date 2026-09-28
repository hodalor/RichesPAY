# MNO connectivity

RichesPay API and worker hosts must send provider traffic from static outbound addresses. Give each mobile network operator the production address and the staging address. Do not give them developer laptop addresses.

The addresses below are documentation placeholders in the TEST-NET range. Replace them with the cloud NAT or egress IP allocated to each environment before any certification call.

| Environment | Host role | Outbound IP |
| --- | --- | --- |
| staging | API and worker NAT | 203.0.113.10 |
| production | API and worker NAT | 203.0.113.20 |

## What to send each MNO

- Production source IP and staging source IP.
- Callback URL on the API host, for example `https://api.richespay.com/callbacks/<provider>`.
- The technical contact and the on-call number from `docs/go-live-checklist.md`.

## VPN or IPsec

Use this when the operator requires a tunnel instead of a public IP allowlist.

1. Create a site-to-site tunnel from the RichesPay production VPC to the operator VPN gateway.
2. Propose IKEv2, AES-256, SHA-256, and a Diffie-Hellman group both sides accept.
3. Limit the RichesPay side of the encryption domain to the API and worker private subnets.
4. Limit the operator side to the documented disbursement and collection endpoints.
5. Route only provider traffic through the tunnel. Merchant dashboard and checkout traffic stays on the public load balancer.
6. Repeat the tunnel for staging against the operator sandbox, using the staging NAT address.
7. Record the allocated public IPs in this file and send the updated table to the operator.

Callback traffic from the operator to RichesPay is inbound to the load balancer, not through the merchant apps. Allow that source only on the callback paths.
