# Connected platform journey

The canonical application entry is
https://workspaceapi-server-production-a679.up.railway.app.
The API service serves both the frontend and `/api`; users do not need separate
onboarding and production links.

## Navigation contract

- Public entry → sign-in or account creation. Authenticated visitors to `/` go to
  `/dashboard`. Clerk has explicit dashboard/sign-up setup fallbacks.
- Protected links require sign-in and then check the user's onboarding/access
  state. Unassigned users stay in setup until an administrator assigns access.
- Required setup preserves the original internal page, query, and anchor through
  activation or deferral. Direct setup opens the selected starting workflow.
- The business shell remains mounted across work areas and record details.
  Sidebar search, sections, facility selection, help, notifications, account,
  and sign-out are shared. Mobile navigation closes on route changes and restores
  content focus. Headers and work area controls wrap on narrow screens.
- Setup & preferences remembers the current work area. Changing facility clears
  cached data and returns to the relevant list, rather than opening an old site's
  record. The server still checks facility membership.
- Save & sign out in setup flushes pending draft changes. Workspace sign-out
  explicitly returns to the public entry and reports a failure instead of silently
  leaving the session open. Identity changes clear the query cache.
- Missing pages and failed page imports offer recovery. A failed business page
  retains the shared navigation; opening another route resets its error boundary.

Administration: Settings → Company Profile → All Facilities → People manages
facility membership. Bootstrap administrator email configuration is server-side;
onboarding cannot grant roles or access.

## Verification — 2026-09-13

`pnpm test` includes internal route/link coverage and regression cases for public
routes, safe onboarding return destinations, and facility-change destinations.
Build/type checking and existing API access/onboarding tests also pass locally.

An isolated browser exercised the actual React application and local API backed
by a separate populated PostgreSQL database. Only the browser's Clerk adapter was
replaced for local testing; production authentication was unchanged.

- 24 work areas, 13 populated record detail screens, and two audit report screens
  rendered without browser exceptions. All 23 standard sidebar work areas kept
  the same shell mounted as links were followed.
- Mobile navigation, focus containment, route changes, and all 23 standard work
  areas were checked at 390px. Page actions, inventory/packaging filters, and
  Settings tabs were fixed where they overflowed the viewport.
- A missing route recovered to the dashboard. A deliberately failed page import
  kept navigation usable and recovered when another work area was opened.
- All four global quality event dialogs opened and closed with usable navigation
  afterward. This caught and fixed a dropdown focus trap that persisted after
  closing a dialog.
- Fixture scenarios verified onboarding activation → requested record/query,
  preferences → previous record, setup sign-out → public entry, protected deep
  links → sign-in → record, and facility switch → work area list.
- Read-only API probes across dashboard, documents, batch records, inventory,
  suppliers, recipes, nonconformances, complaints, CAPA, training, licenses,
  packaging, and lots returned 200.

These checks do not certify all business operations. Personal document queues,
document review recommendations, and personal training require a real Clerk
session and reject the local machine token. Live Clerk sign-in/sign-out, regulated
signatures, external Metrc operations, AI, and outgoing email still require their
own authenticated/configured acceptance checks. No production business records
were created or signed for this review.
