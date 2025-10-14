# Data Standardization Toolkit

Production-ready monday.com marketplace app built with Next.js 14, Supabase, and Tailwind + shadcn/ui. The toolkit standardizes board data via reusable recipes, monetization-aware plan gates, and usage metering.

## Stack

- Next.js 14 (App Router, TypeScript, React Server Components)
- TailwindCSS + shadcn/ui + Zod
- Supabase Postgres (SQL migrations + RPC)
- monday OAuth + HMAC context verification
- Vitest unit tests + Playwright e2e
- GitHub Actions CI (lint, typecheck, unit, e2e)

## Prerequisites

- Node 20+
- pnpm 8+
- Supabase project (or enable the in-memory stub for local testing)
- monday.com app credentials (OAuth + signing secret)

## Project Structure

```
app/                # Next.js routes (marketing, dashboard, monday iframe, APIs)
components/         # UI primitives (shadcn) + app widgets
lib/                # Supabase client, logging, security, recipe engine
scripts/            # migrate.sql + seed.sql
tests/              # Vitest unit + Playwright e2e suites
.github/workflows/  # CI pipeline
```

## Environment Variables

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_URL=<your-supabase-url>
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
MONDAY_CLIENT_ID=<monday-app-client-id>
MONDAY_CLIENT_SECRET=<monday-client-secret>
MONDAY_REDIRECT_URI=http://localhost:3000/api/monday/oauth
MONDAY_APP_SIGNING_SECRET=<monday-signing-secret>
```

For local development without Supabase, set `ENABLE_SUPABASE_STUB=1`. The stub seeds a demo tenant (`demo-account`) using the pro plan, enabling fuzzy dedupe for e2e tests.

## Database Migrations & Seed

Run against your Supabase instance:

```bash
pnpm dlx supabase db push --file scripts/migrate.sql
pnpm dlx supabase db execute --file scripts/seed.sql
```

The seed adds a starter tenant and a CRM recipe template to help with local testing.

## Local Development

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` for the marketing site, or `http://localhost:3000/monday/view?token=<signed-token>` for the embedded board app. Use the `/api/monday/context/verify` endpoint to validate HMAC tokens generated with your signing secret.

## Testing

- `pnpm lint` – ESLint flat config with Next + TypeScript rules
- `pnpm typecheck` – strict TypeScript compilation
- `pnpm test:unit` – Vitest coverage for recipe engine steps
- `pnpm test:e2e` – Playwright scenario covering CSV preview → execute flow (stub Supabase + monday token)
- `pnpm test` – Runs unit + e2e suites

CI (`.github/workflows/ci.yml`) mirrors the above, ensuring lint/typecheck/unit/e2e on every PR.

## Usage Metering & Plan Gates

- `flagsForPlan(plan, seats)` in `lib/entitlements.ts` centralizes feature gates (row caps, fuzzy dedupe, schedules, API access).
- Every execution calls the Supabase `increment_usage` RPC (`usage_monthly` table) to track row counts.
- UI badges (`UsageBadge`, `PlanGate`) mirror server enforcement so premium features remain gated both ways.

## Observability & Security

- `lib/logging.ts` provides structured JSON logs with request IDs/tenant info and PII redaction.
- `/api/health` outputs `{ ok, time, version }` for uptime checks.
- Monday context + webhook signatures validated via HMAC (`lib/security.ts`).
- Service role key usage is isolated to server-only `getServiceSupabase()` (no client exposure).

## Deployment

Deploy to Vercel with the supplied `vercel.json`. Ensure the production environment has all Supabase and monday credentials, and run `scripts/migrate.sql` before the first deploy.

## Sample Recipe JSON

```jsonc
{
  "id": "crm",
  "name": "CRM Contacts",
  "version": 1,
  "steps": [
    { "type": "map_columns", "config": { "mapping": { "FirstName": "first_name", "Email": "email" } } },
    { "type": "format", "config": { "operations": [{ "field": "email", "op": { "kind": "email_normalize" } }] } },
    { "type": "validate", "config": { "rules": [{ "kind": "required", "field": "email" }] } },
    { "type": "write_back", "config": { "strategy": "monday_upsert", "keyColumn": "email" } }
  ]
}
```

Import or edit recipes via the dashboard (`/recipes/[id]`) using the JSON editor, or bootstrap new ones through the `POST /api/recipes/create` endpoint.
