import app from "./app";
import { logger } from "./lib/logger";
import { startDigestScheduler } from "./scheduler";
import { reconcileBootstrapAdmins } from "./lib/currentUser";
import { seedLabelDefaults } from "./lib/seedLabelDefaults";
import { ensureSchema } from "./lib/ensureSchema";
import { seedDemoRecipes } from "./lib/seedDemoRecipes";
import { seedDemoSpecs } from "./lib/seedDemoSpecs";
import { reconcileAllSupplierRisk } from "./routes/suppliers";
import { loadFacilityTimeZone, loadFacilityMetrcConfig, loadRegulatoryRules } from "./routes/facilities";

const rawPort = process.env["PORT"] ?? "3001";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function bootstrap() {
  await ensureSchema();

  // The facility time zone decides which calendar day every date-only column lands
  // on, so it is loaded BEFORE the server accepts a request — a date stamped in the
  // wrong zone is a wrong record, not a cosmetic problem. Falls back to Eastern.
  await loadFacilityTimeZone();

  // The METRC connection now lives on the facility (a facility IS a licence, and
  // METRC issues credentials per licence). Loaded before the server accepts a
  // request so the first METRC call of the day uses the right one. Never fatal —
  // it falls back to the METRC_* environment variables.
  await loadFacilityMetrcConfig().catch((err) => logger.error({ err }, "loadFacilityMetrcConfig failed"));

  // Which state's limits apply to a record is decided by the facility it belongs
  // to, not by whichever regulatory_config row happens to come back first. Loaded
  // before the first request so testing and the tracking provider resolve against
  // the right state from the start. Never fatal — it falls back to default limits.
  await loadRegulatoryRules().catch((err) => logger.error({ err }, "loadRegulatoryRules failed"));

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startDigestScheduler();
    reconcileBootstrapAdmins().catch((err) => logger.error({ err }, "reconcileBootstrapAdmins failed"));
    seedLabelDefaults().catch((err) => logger.error({ err }, "seedLabelDefaults failed"));
    // Session 59.2 — runs after ensureSchema (above) has created the process-step
    // tables, so the demo recipes' steps insert cleanly.
    // Session 66 — seedDemoSpecs binds Approved Work Instructions to the seeded
    // recipes, so it must run AFTER seedDemoRecipes finishes (recipes must exist
    // before a WI can reference recipeId). Chained, not parallel, for that reason.
    seedDemoRecipes()
      .then(() => seedDemoSpecs())
      .catch((err) => logger.error({ err }, "seedDemoRecipes/seedDemoSpecs failed"));
    // SRS-1 Part 2 — seed each supplier's effective (reviewed) risk tier and catch
    // any tier change since the last run. Safe to run on every boot (idempotent).
    reconcileAllSupplierRisk()
      .then(({ scanned }) => logger.info({ scanned }, "Supplier risk reconcile (boot) complete"))
      .catch((err) => logger.error({ err }, "Supplier risk reconcile (boot) failed"));
  });
}

void bootstrap().catch((err) => {
  logger.fatal({ err }, "Startup failed; refusing to serve with an incomplete database or facility context");
  process.exit(1);
});
