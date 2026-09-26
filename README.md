# RichesPay

RichesPay is a multi-tenant payment and SMS gateway monorepo built with pnpm workspaces and Turborepo.

## Workspace

- `apps/api` - Fastify API with Zod validation, OpenAPI generation, request IDs, rate limiting, and graceful shutdown.
- `apps/dashboard` - Merchant dashboard shell.
- `apps/admin` - Back-office shell for RichesPay staff.
- `apps/checkout` - Hosted checkout shell.
- `packages/shared` - Shared money, ID, and error helpers.
- `packages/ui` - Design system package placeholder wired into the browser apps.
- `supabase` - Local Supabase project scaffold.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker Desktop for local Redis
- Supabase CLI if you want to run local Supabase services

## Setup

1. Copy each `.env.example` to `.env` in:
   - `apps/api`
   - `apps/dashboard`
   - `apps/admin`
   - `apps/checkout`
2. Install dependencies:

```bash
pnpm install
```

3. Start Redis:

```bash
docker compose up -d redis
```

4. If you have the Supabase CLI installed, start local Supabase services:

```bash
supabase start
```

## Run

Start the whole monorepo:

```bash
pnpm dev
```

The default local URLs are:

- API: `http://127.0.0.1:3000`
- Dashboard: `http://127.0.0.1:5173`
- Admin: `http://127.0.0.1:5174`
- Checkout: `http://127.0.0.1:5175`

## Verification

Run the checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Confirm the API health endpoint:

```bash
curl http://127.0.0.1:3000/health
```

Expected response:

```json
{"data":{"status":"ok"}}
```

OpenAPI is exposed at:

```text
http://127.0.0.1:3000/v1/openapi.json
```
