# CannaQ

Quality management for cannabis operators: supplier qualification, incoming
inspection, inventory and lot traceability, recipes and batch records, laboratory
testing, packaging and labels, nonconformances, CAPA, complaints, field actions,
controlled documents, training, audit history, and facility-specific Metrc access.

## Application entry

Open [CannaQ](https://workspaceapi-server-production-a679.up.railway.app).
The same address serves sign-in, workspace setup, and all business work areas.
Returning users reach their dashboard; users completing setup continue to their
requested page or chosen starting workflow. Sign-out returns to the public entry.
See [platform navigation and verification](docs/PLATFORM_NAVIGATION.md).

## Run locally

Requires Node.js 22.12+ (22 LTS recommended), pnpm 10.16, PostgreSQL, and a Clerk
development instance. Copy `.env.example` to `.env` and fill in the database and
Clerk keys. For Railway databases, use the resolved **public** connection URL on
your computer; `${{Postgres.DATABASE_URL}}` and internal hostnames do not resolve
locally. All Clerk keys must belong to the same instance.

```sh
pnpm install --frozen-lockfile
pnpm check:env
pnpm db:migrate
pnpm build
pnpm start
```

Open `http://localhost:3001`. Set `BOOTSTRAP_ADMIN_EMAILS` to the initial
administrator's email before their first sign-in. Configure the company,
facilities, people, and regulatory settings in the application.

Use `db:migrate` on a fresh database. Existing databases provisioned before
versioned migrations need a reviewed baseline; see [deployment](docs/RAILWAY_DEPLOYMENT.md).
`db:push` is an explicit schema operation: review its proposed changes before
accepting them on an existing database. Startup applies the existing idempotent
schema additions and audit triggers; it does not run `drizzle-kit push --force`.
The database account must be able to create/assume the `cannaqms_scoped` role.
Use a separate test database for validation, never a customer's production data.

For development, run these in separate terminals:

```sh
pnpm dev:api
pnpm dev:web
```

The web development server uses port 5000 and proxies `/api` to port 3001.
Override `API_PROXY_TARGET` in the shell if the API uses another port. Runtime
scripts and Vite load the root `.env`; build-time `VITE_*` values become public
browser configuration and must never contain secrets.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
```

CI runs install, build/typecheck, and regression tests on Windows and Linux.
The tests exercise API access control through real HTTP requests, quantity
conversion, sample-panel resolution, and transfer query bounds. They do not
certify every business workflow or external integration. See
[the review](docs/CODEBASE_REVIEW.md) and [requirements](docs/REQUIREMENTS.md)
for the remaining functional validation work.

`GET /health`, `/api/health`, and `/api/healthz` are public and return 200 only
after bootstrap succeeds. All business API routes require an active user;
individual routes retain their role/signature checks. Uploads are stored in
PostgreSQL. AI assistance and email require their optional credentials. Metrc
writes stay disabled unless `METRC_WRITE_ENABLED=true`; use sandbox credentials
for testing and retain each route's preview/confirmation requirements.

## Repository layout

| Path | Purpose |
| --- | --- |
| `artifacts/cannaqms` | React/Vite frontend |
| `artifacts/api-server` | Express API, domain rules, integration clients |
| `lib/db` | Drizzle schema and request-scoped database access |
| `lib/db/migrations` | Versioned base schema and subsequent database migrations |
| `.railway/railway.ts` | Single-service production deployment configuration |
| `lib/api-spec` | OpenAPI source and generation configuration |
| `lib/api-client-react`, `lib/api-zod` | Generated client and validation contracts |
| `lib/integrations-anthropic-ai` | Lazy AI client |
| `migrations` | Historical SQL migrations retained for existing installations |
| `scripts` | Explicit maintenance and test-data tools |
| `docs` | Requirements, references, validation material, review |

Do not edit generated API files by hand. Regenerate with
`pnpm --filter @workspace/api-spec codegen` after updating the OpenAPI source.
Some newer routes use handwritten clients and are not yet in the specification.

The legacy `seed` command truncates data. It now refuses production and requires
`SEED_CONFIRM=yes-replace-test-data`. The separate sandbox reset also has an
explicit confirmation guard. Neither is part of normal startup or verification.
