# Go-live checklist

Complete every item before the first live merchant is enabled. Keep the evidence link next to the box.

## Licences and certification

- [ ] Bank of Ghana approval for the Ghana payment service.
- [ ] Bank of Zambia approval for the Zambia payment service.
- [ ] MTN MoMo Ghana certification signed off.
- [ ] Telecel Cash Ghana certification signed off.
- [ ] AT Money Ghana certification signed off.
- [ ] MTN MoMo Zambia certification signed off.
- [ ] Airtel Money Zambia certification signed off.
- [ ] Zamtel mobile money certification signed off.
- [ ] Card acquirer certification signed off, including 3-D Secure.
- [ ] SMS routes for Ghana and Zambia accepted by each operator.

## Security and resilience

- [ ] Data residency confirmed for Ghana and Zambia data stores.
- [ ] PCI self-assessment completed. RichesPay does not store card numbers.
- [ ] Disaster recovery and backup restore tested against the production Supabase project.
- [ ] Production and staging each use a separate Supabase project, Redis, and secret set.
- [ ] API and worker outbound IPs recorded in `docs/runbooks/mno-connectivity.md` and sent to each operator.
- [ ] Prometheus alerts from `ops/prometheus/alerts.yml` routed to the on-call channel.
- [ ] Sentry project receiving API errors with phone, email, and card values scrubbed.

## Operations

- [ ] On-call rota published for the launch week.
- [ ] Support contacts published for merchants and for each operator.
- [ ] First merchants created in test mode only.
- [ ] Live access remains off until KYB approval for each of those merchants.
- [ ] Public status page at `/status` shows Ghana and Zambia channels.
- [ ] Staging deploy succeeded, production approval was given by a reviewer, and the production rolling restart kept `/health` green.
