# CannaQ — workspace setup and operational interface

The active objective is a deep, functional onboarding journey and a cohesive,
contemporary application UI that feels intuitive, gentle, and calm. Completion
requires verified behavior and rendered review, not just new styling.

## Experience requirements

- A business QMS interface for cannabis operations: strong technical typography,
  legible records, facility and licence context, restrained status color, and
  structured navigation. No lifestyle branding, decorative botanical art,
  oversized editorial serif headlines, or generic pill-box dashboards.
- Six operational setup steps: overview, account identity, licensed facility,
  display and density, starting workflow, and review/activation.
- Server-persisted personal progress; resume across sessions and devices. Back,
  save for later, retry, stale-tab conflict recovery, and an honest completion gate.
- Administrative workspace setup writes real company/facility records atomically.
  Existing workspaces are preserved. Joining staff see their assigned workspace;
  unassigned staff get a clear waiting state, never elevated access.
- Personal preferences actually affect the application. Role is assigned by an
  administrator and is never a self-service onboarding choice.
- Contextual orientation explains records, review, and traceability without
  signing records or claiming any legal/compliance certification.
- A discoverable return to onboarding and a gentle next-action surface after it.
- Shared application shell, navigation, forms, tables, dialogs, statuses, landing,
  sign-in, and dashboard must feel like the same product. Existing domain actions
  and status semantics remain available.
- Keyboard access, visible focus, announced save/error states, reduced motion,
  usable mobile navigation, responsive forms, and light/dark contrast.

## Verification required before completion

1. SQL-backed onboarding route tests: isolation, role checks, draft/resume, stale
   revisions, validation, atomic completion, defer/resume, and idempotency.
2. Browser journeys for a new administrator, joining staff, and returning user;
   exercise actual saves, failures/retries, back/reload, and final navigation.
3. Rendered desktop/mobile review of onboarding, sign-in, shell, dashboard, a
   representative list, a detail page, and a form/dialog in both themes.
4. Keyboard and reduced-motion checks; all local builds/typechecks/tests and CI.
5. Verify real Clerk/database deployment when a resolved test connection is
   available. Local SQL-backed fixtures do not prove the deployed integration.

## Product direction

The user rejected the initial editorial/botanical concept as generic. The revised
system centers licensed sites, record identity, traceability and practical setup.
The supplied 2026 experience-design reference informs explicit task selection,
user-controlled guidance and density, semantic hierarchy, and limited translucent
navigation chrome with opaque record surfaces. It does not justify adding
unrequested AI, emotional inference, or voice functionality.

## Design references

- [User-supplied UX Collective article](https://uxdesign.cc/the-most-popular-experience-design-trends-of-2026-3ca85c8a3e3d): task intent, presentation control, and readable layering.

- [Linear, A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh): consistent placement and reduced navigation noise.
- [Apple HIG, Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding): contextual guidance and optional instruction.

## Verified on 12 September 2026

- All nine automated tests pass. SQL-backed coverage includes identity and role
  checks, draft persistence, stale revisions, required fields, workspace creation,
  existing-record preservation, replay safety, deferred setup, inactive accounts,
  rejected facility selection and one-time legacy membership migration.
- The updated Railway connection works. A read-only copy of application data was
  used in an isolated local PostgreSQL server. The full API started successfully;
  22 read-only endpoint checks passed across dashboard, records and configuration.
  No migrations or record changes were applied to the source database.
- Onboarding save, stale revision rejection, defer, complete and replay passed
  against that full PostgreSQL copy. Existing company and facility values were
  preserved. The migration retained access for 26 active legacy users.
- The isolated browser journey completed all six steps, including actual SQL
  saves, dark/compact/focused preferences, reload, connection-loss recovery and
  stale-tab recovery. Mobile review covered 390px and 320px widths. Shared layout,
  record filtering, detail presentation and a form dialog were rendered separately.
  Mobile keyboard checks verified focus containment and Escape return focus.
- Assigned-operator onboarding passed in the browser with a read-only facility
  summary and production starting workflow. Pending staff could pause, resume,
  and retrieve a newly assigned facility without losing their identity confirmation.
  Returning-user preferences survived save/return and reload. Completed users can
  move directly between steps and return after editing their preferences.
- The full local application passed file upload, attachment registration and
  byte-for-byte download checks. Anonymous access, missing files, unsupported
  content types and downloads of unattached blobs were rejected.
- Metrc configuration and facilities diagnostics correctly reported missing
  configuration. Neither the source .env nor source database currently supplies
  vendor/user credentials; no live Metrc request or write was attempted.
- Production build and type checks pass. The build explicitly selects production
  mode so a development NODE_ENV in the local .env cannot bundle React debug code.
  Main entry: 463 KB (143 KB gzip); batch detail: 243 KB (60 KB gzip).
- Unused Clerk theme dependency and abandoned visual assets/styles were removed.

## Remaining verification

Clerk email verification is pending in the real application tab. Full signed-in
browser journeys on the copied database and live Metrc connectivity remain
outstanding. Upload transport is verified; the signed-in attachment UI still
needs browser review. The additional staff and returning-user journeys above
used the isolated SQL-backed onboarding harness.
The isolated review pages are evidence for shared UI and onboarding behavior;
they are not evidence that every production workflow or external service works.

## Reproduce isolated UI review

Run the following in separate terminals from the repository root:

```sh
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/tests/onboarding-preview.ts
pnpm dev:web
```

Open /tests/onboarding.html or /tests/workspace.html on the local Vite server.
The onboarding preview uses an in-memory SQL fixture and a loopback-only API on
port 3002. POST /review/fault with {"unavailable":true} to that fixture API to test
save failure; send false to recover. Preview entry points are excluded from the
production build. The normal /api proxy still targets the real application API.

The onboarding review also accepts ?scenario=member, ?scenario=pending and
?scenario=returning. These use a second isolated database containing a configured
facility. POST /review/assign on port 3002 simulates assigning the pending fixture
user, so the access-refresh path can be reviewed without live account changes.
