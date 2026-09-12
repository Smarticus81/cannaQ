// ---------------------------------------------------------------------------
// Metrc Phase 0 connectivity smoke test (standalone, no deploy needed)
// ---------------------------------------------------------------------------
//
// Authenticates against the Metrc sandbox and calls GET /facilities/v2, which
// reports the facilities + per-facility permissions the state granted. This is
// the build plan's #1 next action and the anchor of the Proficiency Evaluation.
//
// Run it with your sandbox keys in the environment (they are NOT stored in the
// repo). From the repo root, with pnpm:
//
//   METRC_VENDOR_KEY="<vendor key>" \
//   METRC_USER_KEY="<api user key>" \
//   pnpm --filter @workspace/scripts metrc-smoke
//
// Optional overrides:
//   METRC_BASE_URL        (default: https://sandbox-api-mi.metrc.com)
//   METRC_LICENSE_NUMBER  (not needed for /facilities; shown for reference)
//
// Expected outcomes:
//   HTTP 200 → success. Prints each facility, its license, and its capability
//              flags. This is the result you capture for the eval.
//   HTTP 401 → keys are present but not authorized for this call. Check that
//              BOTH keys are set and the API user key is still valid (re-run
//              IntegratorSetup in Postman if the vendor key was regenerated).
// ---------------------------------------------------------------------------

// This file uses top-level await, so it must be an ES module. It has no other
// imports/exports, so we add an empty export to mark it as a module (TS1375).
export {};

const SANDBOX_MI_HOST = "https://sandbox-api-mi.metrc.com";

const vendorKey = (process.env.METRC_VENDOR_KEY ?? "").trim();
const userKey = (process.env.METRC_USER_KEY ?? "").trim();
const baseUrl = (process.env.METRC_BASE_URL ?? SANDBOX_MI_HOST).trim().replace(/\/+$/, "");
const licenseNumber = (process.env.METRC_LICENSE_NUMBER ?? "").trim() || null;

if (!vendorKey || !userKey) {
  console.error("ERROR: set METRC_VENDOR_KEY and METRC_USER_KEY in the environment.");
  console.error("  Vendor key present:", !!vendorKey, "| User key present:", !!userKey);
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${vendorKey}:${userKey}`).toString("base64");
const url = `${baseUrl}/facilities/v2`;

console.log("Metrc Phase 0 smoke test");
console.log("  Host       :", baseUrl, /sandbox/i.test(baseUrl) ? "(sandbox)" : "(PRODUCTION)");
console.log("  License    :", licenseNumber ?? "(not set — not required for /facilities)");
console.log("  GET        :", url);
console.log("");

const resp = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
const text = await resp.text();

console.log(`HTTP ${resp.status} ${resp.statusText}`);

if (!resp.ok) {
  console.error("\nMetrc refused the call.");
  console.error(text.slice(0, 800));
  if (resp.status === 401 || resp.status === 403) {
    console.error(
      "\n401/403 = authenticated but not permitted. Confirm both keys are set and the API user key is still valid.",
    );
  }
  process.exit(2);
}

let facilities: unknown;
try {
  facilities = text ? JSON.parse(text) : [];
} catch {
  console.error("\nGot HTTP 200 but the body was not JSON:\n", text.slice(0, 800));
  process.exit(3);
}

const list = Array.isArray(facilities) ? facilities : [];
console.log(`\nSuccess — ${list.length} facility(ies) returned:\n`);

for (const f of list as Array<Record<string, any>>) {
  const name = f.Name ?? f.DisplayName ?? "(unnamed)";
  const lic = f.License?.Number ?? "(no license #)";
  const type = f.License?.LicenseType ?? "(unknown type)";
  const ft = f.FacilityType && typeof f.FacilityType === "object" ? f.FacilityType : {};
  const caps = Object.entries(ft)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  console.log(`• ${name}`);
  console.log(`    License : ${lic} (${type})`);
  console.log(`    Manager : ${f.IsManager === true ? "yes" : f.IsManager === false ? "no" : "—"}`);
  console.log(`    Capabilities: ${caps.length ? caps.join(", ") : "(none reported)"}`);
}

console.log("\nPhase 0 connectivity confirmed. Capture this output for the Proficiency Evaluation.");
process.exit(0);
