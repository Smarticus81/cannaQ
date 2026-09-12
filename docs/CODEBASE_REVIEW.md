# Codebase review and cleanup — 2026-09-12

## Result

The application is a substantial QMS, not an empty scaffold. The clearest excess
was an unused second frontend, generated UI components with no callers, obsolete
integration code, historical handoffs, and platform-specific build scaffolding.
Those were removed without removing any currently routed application screen.

253 files (about 1.45 MiB) were moved into an external recovery archive. The
original checkout was also zipped before cleanup. See [the manifest](CLEANUP_MANIFEST.md).
Requirements, historical SQL migrations, source specifications, and validation
documents remain; reference/validation documents now live under `docs/`.

The first successful build after file cleanup still bundled every page into one
2,711.77 KB JavaScript entry. Lazy route loading reduced that entry to 454.95 KB
(83.2% smaller; gzip 696.17 KB → 140.06 KB). The remaining page code is downloaded
when needed; this is an initial-load improvement, not a claim that all application
code disappeared.

## Defects fixed

| Finding | Change | Evidence |
| --- | --- | --- |
| Business APIs lacked a shared authentication gate; several list/create routes had no local authentication check | Every business route now requires an active account before facility scoping or database work; public health remains available | Real HTTP tests against the application: six anonymous list routes and a supplier write return 401; no DB connections opened |
| Inactive accounts could be returned by the shared user resolver; boot reconciliation reactivated bootstrap administrators | Inactive users are refused and bootstrap reconciliation no longer reactivates disabled accounts | Code review; gate covers inactive-account refusal in an HTTP test; persisted disable/restart lifecycle still needs a database test |
| Facility lookup errors silently fell back to the primary site | Lookup errors return 503 instead of changing facility | Code review; needs database fault-injection verification |
| A failed pool-session reset still returned the connection for reuse | Failed resets discard the connection | Code review; needs database fault-injection verification |
| Schema/facility initialization failures were swallowed and the server could listen anyway | These startup failures now terminate startup | Code review; live startup pending the resolved test DB connection |
| Startup forced a database schema push on every launch | Schema push is an explicit `db:push` operation; normal startup preserves the existing additive schema bootstrap | Package script inspection |
| Dependency overrides suppressed native Windows packages; Unix shell scripts were required for install/dev | Removed platform exclusions and replaced shell-specific commands; root environment-file loading added | Frozen-lockfile install, typecheck, production builds on Windows |
| Dev frontend had no API proxy | `/api` forwards to the local API; root `.env` supplies Vite settings | Configuration inspection; authenticated dev flow still pending |
| API code generation used shell-dependent quoted `echo` | Kept the stable export file and removed the shell rewrite | Package script inspection; no generated contracts changed |
| Generic seed command truncated data without a production guard | Refuses production and requires an explicit test-data confirmation variable | Code review; destructive seed was not executed |
| All screens loaded in the initial browser bundle | Routes use React lazy/Suspense with a loading state and the existing error boundary | Production bundle measurements and browser checks |
| Signed-out visitors could open business screens and see misleading empty-data views | A shared frontend session guard redirects business routes to Clerk sign-in before rendering the screen | Browser regression check |

Also removed the unused mockup application, 35 unreachable frontend modules,
two obsolete Google/Replit storage modules, duplicate/unused AI batch helpers,
unused dependencies, Replit development plugins, and the speculative list of
dozens of build externals. Actual PostgreSQL uploads and the AI client remain.

Dependency remediation refreshed compatible versions and replaced the pinned vulnerable
esbuild/codegen/upload versions. The initial audit reported 76 advisories
(11 critical, 41 high, 20 moderate, 4 low); the final `pnpm audit` reports zero
known vulnerabilities across the installed dependency graph. This is a registry
audit result, not proof that the application has no security defects.

## Verification performed

- `pnpm install --frozen-lockfile`: passes on Windows, pnpm 10.16.
- `pnpm typecheck`: all shared libraries, API, frontend, and scripts pass.
- `pnpm build`: API and frontend production builds pass.
- `pnpm test`: five regression tests pass, including real HTTP access checks,
  active/inactive account handling, unit conversion, sample panels, and query bounds.
- Browser: landing and Clerk sign-in render using the supplied development keys;
  an anonymous `/batches` visit redirects to sign-in with its return URL.
- `.env` is ignored by Git; no real credentials are included in `.env.example`.
- CI is configured for Windows and Linux. Remote CI results are separate from the
  local results above and must be checked after push.

These checks do **not** establish full application functionality. At review time,
the supplied database configuration still contained Railway references and could
not resolve from this computer. Database lifecycle tests, authenticated screen
workflows, email delivery, AI calls, and Metrc operations remain unverified here.

## Findings requiring the next functional pass

1. **Facility membership lifecycle:** `facilityContext.ts` still defaults users
   with no membership to the primary site. `ensureSchema.ts` inserts every user
   into the primary facility on every startup. Define explicit onboarding and
   revocation behavior, then test users with zero/one/multiple memberships and a
   restart. The bootstrap membership insertion can undo a revoked membership.
2. **Parent/child facility isolation:** RLS covers selected parent tables. Many
   child routes select by child ID directly. Review each against membership and
   the parent record's facility, especially ingredients, process steps, test
   results, attachment metadata, and blobs. Do not infer tenant isolation merely
   because parent list routes use RLS.
3. **Business-write permissions:** the new gate guarantees authentication, not a
   uniform role matrix. Some routes have fine-grained role/signature checks and
   some only require an authenticated account. Exercise every operation against
   the documented Admin/Quality/Operator expectations.
4. **Atomicity and audit evidence:** some multi-write workflows use transactions
   and others perform sequential independent writes. Audit helpers and trigger
   installation contain catch-and-continue paths. Test interruption, duplicate
   submission, concurrent inventory consumption, and audit failure before
   claiming complete electronic-record guarantees.
5. **Production/test separation:** the admin sandbox-reset endpoint is explicitly
   capable of clearing production-hosted data after an Admin confirmation. Demo
   recipe/spec seeders also still run at boot. Decide a clear environment policy
   before customer deployment; historical validation evidence must remain intact.
6. **API contract coverage:** the generated API specification covers only part of
   the implemented API; newer features use handwritten fetches and types. Expand
   contracts incrementally around tested workflows, rather than deleting generated
   files that remain in use.
7. **Complexity:** large batch, document, and settings modules mix routing,
   validation, persistence, and presentation. Extract domains only after adding
   lifecycle tests; a mechanical rewrite would create unnecessary regression risk.

## Known product gaps from the existing requirements register

The register is historical evidence supplied with the project. Its earlier
“verified” labels are not new verification by this cleanup.

| Workflow | Remaining work |
| --- | --- |
| Stranded recipe ingredient (C2) | Define and implement a signed correction/substitution path that preserves the original recipe and inventory provenance |
| Facility default for concentrate panels (A7 follow-on) | Add the site-level solvent/solventless default; explicit per-sample overrides currently exist |
| Infused pre-roll component eligibility (ICC) | Scope and implement eligibility checks for cannabis components and final-product testing using the authoritative requirements |
| Laboratory result retrieval (A8) | End-to-end verification needs a laboratory with custody of a sample or appropriate sandbox UI access |
| Registered outbound transfer (B6) | The existing workflow pushes a template; completing registration requires Metrc UI access under the documented integration limitations |
| Batch sampling/release and labels | Exercise every pass/fail/pending path, signatures, checklist completeness, quantity changes, and upload/download of the CoA |
| Whole-system audit claim (D2) | Reconcile hard-delete/reset exceptions with append-only expectations and verify complete audit evidence |

## Acceptance sequence

Use a disposable clone of the intended test database and named test accounts.
First prove startup, login/logout, disabled accounts, membership isolation,
role restrictions, and uploads. Then run supplier → receipt/inspection → lot →
recipe/batch → consumption → sampling/results → labeling → finished goods →
manifest, checking persistence and audit entries after each transition. Run NC,
CAPA, complaint/field action, document revision/training, and management review
lifecycles separately. Exercise external integrations in their approved test
environments. Record actual evidence against each requirement and retain any
unverifiable status until its external prerequisite is available.
