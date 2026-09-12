// Local development review only. Not imported by the application entry point.
import express from "express";
import { onboardingFixture } from "./onboarding-fixture";
import { createOnboardingRouter } from "../src/routes/onboarding";
const fixture = await onboardingFixture();
const established = await onboardingFixture();
const first = await established.service.get(established.actors.admin);
const configured = await established.service.save(
  established.actors.admin,
  first.revision,
  {
    ...first.draft,
    identityConfirmed: true,
    companyName: "CannaQ Review Company",
    facilityName: "Review Processing Facility",
    licenseNumber: "LOCAL-REVIEW-001",
  },
);
const workspace = await established.service.complete(
  established.actors.admin,
  configured.revision,
);
await established.pg.query(
  "INSERT INTO user_facilities(user_id,facility_id) VALUES(2,$1),(3,$1)",
  [workspace.facility!.id],
);
const returning = await established.service.get(established.actors.colleague);
const confirmed = await established.service.save(
  established.actors.colleague,
  returning.revision,
  {
    ...returning.draft,
    identityConfirmed: true,
    focus: "quality",
  },
);
await established.service.complete(
  established.actors.colleague,
  confirmed.revision,
);
const pending = {
  ...established.actors.inactive,
  active: true,
  fullName: "Jordan Lee",
  initials: "JL",
  role: "Quality",
};
const app = express();
app.use(express.json());
app.post("/review/assign", async (_req, res) => {
  await established.pg.query(
    "INSERT INTO user_facilities(user_id,facility_id) VALUES(4,$1) ON CONFLICT DO NOTHING",
    [workspace.facility!.id],
  );
  res.json({ assigned: true });
});
let unavailable = false;
app.post("/review/fault", (req, res) => {
  unavailable = req.body.unavailable === true;
  res.json({ unavailable });
});
app.use("/api", (_req, res, next) => {
  if (unavailable)
    res.status(503).json({
      error:
        "The review connection is temporarily unavailable. Your edits are still here.",
    });
  else next();
});
app.use(
  "/api",
  createOnboardingRouter(fixture.service, async () => fixture.actors.admin),
);
for (const [name, actor] of Object.entries({
  member: established.actors.member,
  returning: established.actors.colleague,
  pending,
})) {
  app.use(
    `/api/review/${name}`,
    createOnboardingRouter(established.service, async () => actor),
  );
}
app.listen(3002, "127.0.0.1", () =>
  console.log("Isolated onboarding review API: http://127.0.0.1:3002"),
);
