# Railway deployment

CannaQ runs as one application service, `@workspace/api-server`, plus `Postgres`
in project `reasonable-clarity`, environment `production`. The API serves the
built React frontend and same-origin API routes. No Vite development server is
needed in production. Upload content is stored in PostgreSQL.

## Commands and configuration

Run all commands from the repository root (Railway Root Directory `/`).

| Setting | Value |
| --- | --- |
| Build | `pnpm build:prod` |
| Pre-deploy | `pnpm db:migrate` |
| Equivalent package command | `pnpm --filter @workspace/db db:migrate` |
| Start | `pnpm start` |
| Healthcheck | `/health`, timeout 300 seconds |
| Port | `PORT=8080`, public domain target port 8080 |

`build:prod` checks the public Clerk build key, then runs the existing workspace
typecheck/build, including both API and frontend. The frontend output is
`artifacts/cannaqms/dist/public`. Production startup refuses to run without its
`index.html`. The API binds `0.0.0.0` and uses `PORT` (local default 3001).

The maintained configuration is [`.railway/railway.ts`](../.railway/railway.ts).
It includes build/start/pre-deploy commands, healthcheck, restart policy and
watch paths for both apps, libraries, scripts, workspace manifests and config.
Secrets use `preserve()` and remain in Railway. The generated public domain is
also retained by Railway. Add any optional variables to this file with
`preserve()` when enabling them, so a later apply keeps them.

Railway now uses [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code).
Legacy `railway.json`/`railway.toml` support ends on December 1, 2026, and new
services cannot opt into it. The IaC file is applied through the CLI; merely
pushing it does not apply project configuration.

```sh
railway login
pnpm dlx @railway/cli@5.54.0 link --project 2385badd-aa69-4941-895d-ddc515cd8430 --environment production
pnpm railway:plan
pnpm railway:apply
```

The installed CLI may be older; the package scripts pin a compatible CLI.
Before the first apply, inspect the plan against live state. The intended
result retains the existing Postgres service, credentials and mounted volume,
retains the API and its domain, and removes the six duplicate services listed
below. A plan that replaces Postgres, detaches/deletes its volume or removes
unrelated resources must be corrected before applying. `railway config pull`
(without `--include-variables`) can import current resources with secrets
preserved if the project has changed since this definition was written.

## Environment variables

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | Required at pre-deploy/runtime. Use `${{Postgres.DATABASE_URL}}` on Railway. |
| `NODE_ENV` | Set to `production` on Railway. |
| `CLERK_SECRET_KEY` | Required at runtime. Secret; never use a `VITE_` prefix. |
| `CLERK_PUBLISHABLE_KEY` | Required at runtime. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Required at production build and runtime; must equal `CLERK_PUBLISHABLE_KEY`. Rebuild when changing it. |
| `BOOTSTRAP_ADMIN_EMAILS` | Set the initial administrator's email before first sign-in on a fresh database. Optional after an administrator exists. |
| `PORT` | Railway port; configured as 8080 to match this service's domain. Local default 3001. |
| `DATABASE_POOL_MAX` | Optional positive integer; default 30. |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Optional; enables AI assistance. |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | Optional; default `https://api.anthropic.com`. |
| `RESEND_API_KEY` | Optional; enables digest email delivery. |
| `METRC_BASE_URL` | Optional; defaults to Michigan sandbox. Facility configuration can override it. |
| `METRC_VENDOR_KEY`, `METRC_USER_KEY`, `METRC_LICENSE_NUMBER` | Optional environment fallback for facility Metrc settings; required when actually using that integration. |
| `METRC_WRITE_ENABLED` | Optional; default false. |
| `SERVICE_API_TOKEN`, `SERVICE_API_USER_EMAIL` | Optional machine access; configure both together. Email must resolve to an active application user. |

Use all Clerk keys from the same instance. The server reports every missing
required variable together before importing clients or opening connections.
Optional integrations do not prevent the core application from starting.

## Fresh database and upgrades

`pnpm db:migrate` runs Drizzle's versioned migrations in `lib/db/migrations`.
The initial migration creates the 75 base tables, relationships and indexes.
`drizzle-kit` is a runtime dependency of `@workspace/db`, and the SQL plus
migration journal are committed. Railpack must retain the workspace and its
dependencies in the application image. The pre-deploy command connects over
Railway's private network and stops deployment if migration fails.

After migration, bootstrap applies the existing additive schema updates,
membership backfill, audit triggers and facility settings. The database role
must be able to create/assume `cannaqms_scoped` (Railway's Postgres owner can).
No HTTP listener opens until essential bootstrap completes. Public `/health`,
`/api/health` and the existing `/api/healthz` return JSON 200 only after that
point; an app instance imported without bootstrap reports 503. Readiness is
a startup gate, not continuous monitoring of every external integration.

Do not run the initial migration blindly against an older populated database
created by `db:push` or historical SQL: it has no Drizzle migration history.
It will fail on existing tables without dropping them. Such installations
need a reviewed schema comparison and migration-history baseline first.
The historical root `migrations/` directory is not the Drizzle migration path.
Never use `push-force` to bypass this deployment issue.

For future changes, edit the Drizzle schema, run
`pnpm --filter @workspace/db db:generate`, review the generated SQL and check
for overlap with startup additions, then commit SQL, snapshot and journal.

## Remove accidental services

After the combined API deployment passes `/health`, `/`, `/onboarding` and
built-asset checks, remove:

- `@workspace/cannaqms` (the old standalone frontend)
- `@workspace/db`
- `@workspace/api-spec`
- `@workspace/api-zod`
- `@workspace/api-client-react`
- `@workspace/integrations-anthropic-ai`

The final IaC definition intentionally omits these services. Its first apply
therefore includes their deletion; review those exact names. Keep `Postgres`
and `@workspace/api-server`. Do not delete the database volume.

## Regression verification

`pnpm test` covers configuration validation and readiness alongside the
existing authentication, workflow and onboarding tests. CI also provisions
an empty PostgreSQL 18 database, builds production assets and runs
`pnpm test:bootstrap`. That check verifies missing-schema failure, migration
twice, full bootstrap, health, SPA deep links/assets and anonymous API rejection.

To run it locally, supply `TEST_DATABASE_URL` for an empty **loopback-only**
test database and optionally `TEST_API_PORT` (default 8080). The check leaves
its initialized database for inspection; it refuses a nonempty database.
It never falls back to the application's `DATABASE_URL` or `.env`.
