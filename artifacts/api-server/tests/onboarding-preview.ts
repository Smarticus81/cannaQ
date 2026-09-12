// Local development review only. Not imported by the application entry point.
import express from "express";
import { onboardingFixture } from "./onboarding-fixture";
import { createOnboardingRouter } from "../src/routes/onboarding";
const fixture = await onboardingFixture();
const app = express();
app.use(express.json());
let unavailable = false;
app.post("/review/fault", (req, res) => {
  unavailable = req.body.unavailable === true;
  res.json({ unavailable });
});
app.use("/api", (_req, res, next) => {
  if (unavailable)
    res
      .status(503)
      .json({
        error:
          "The review connection is temporarily unavailable. Your edits are still here.",
      });
  else next();
});
app.use(
  "/api",
  createOnboardingRouter(fixture.service, async () => fixture.actors.admin),
);
app.listen(3002, "127.0.0.1", () =>
  console.log("Isolated onboarding review API: http://127.0.0.1:3002"),
);
