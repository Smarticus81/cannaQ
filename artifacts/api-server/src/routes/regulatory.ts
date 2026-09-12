import { Router } from "express";
import { db } from "@workspace/db";
import { regulatoryConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getActingFacilityId } from "../middlewares/facilityContext";
import { getRegulatoryRulesForFacility, getFacilityState } from "../lib/regulatoryRules";

const router = Router();

router.get("/regulatory-config", async (req, res) => {
  try {
    const configs = await db.select().from(regulatoryConfigTable).orderBy(regulatoryConfigTable.state);
    res.json(configs);
  } catch (err) {
    req.log.error({ err }, "Failed to list regulatory configs");
    res.status(500).json({ error: "Failed to list regulatory configs" });
  }
});

/**
 * GET /regulatory-config/resolved — which rule set actually applies HERE.
 *
 * The list endpoint says what rule sets EXIST; this says which one the server
 * resolves for the facility this request is acting for, using the same resolver
 * the lab-results pull and the tracking provider use. Without it, "the right
 * state's limits are being applied" is something you can only infer — and with
 * three states configured, the first row in the table is Illinois while a
 * Michigan facility must come back Michigan. `configured: false` means no rule
 * set matched and the defaults are standing in.
 */
router.get("/regulatory-config/resolved", async (req, res) => {
  try {
    const facilityId = getActingFacilityId();
    const rules = getRegulatoryRulesForFacility(facilityId);
    res.json({
      facilityId,
      facilityState: getFacilityState(facilityId),
      ...rules,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to resolve the regulatory rule set");
    res.status(500).json({ error: "Failed to resolve the regulatory rule set" });
  }
});

router.get("/regulatory-config/:state", async (req, res) => {
  try {
    const [config] = await db.select().from(regulatoryConfigTable).where(eq(regulatoryConfigTable.state, req.params.state));
    if (!config) { res.status(404).json({ error: "Config not found" }); return; }
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "Failed to get regulatory config");
    res.status(500).json({ error: "Failed to get regulatory config" });
  }
});

// ⛔ REMOVED 2026-08-31 — GET/PUT /label-requirements and the facility-level
// assignment they wrote to. They stored ONE answer per SITE for where a
// requirement is met; coverage belongs to the artefact that does the carrying,
// so it now lives on the packaging design (routes/packaging.ts) and, next, on
// the label template. Nothing called these any more.
//
// ⚠️ The `facility_requirement_assignments` TABLE is deliberately left in the
// database. It holds the answers recorded on 2026-08-30, dropping it is
// irreversible, and dead rows cost nothing. What mattered was removing the code,
// so nobody wires a screen back to the wrong source of truth.

export default router;
