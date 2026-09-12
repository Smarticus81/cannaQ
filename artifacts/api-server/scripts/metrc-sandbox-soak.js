/* ===========================================================================
 * Metrc sandbox soak test — CannaQMS /metrc endpoints
 * ===========================================================================
 *
 * WHAT THIS IS
 *   Exercises the CannaQMS Metrc API routes (NOT Metrc directly, and NOT the
 *   UI) against the Michigan SANDBOX, to prove the whole path through our own
 *   code works: reads, the guardrails (403 switch-off / 428 unconfirmed), the
 *   dry-run preview payloads, and a full confirmed write lifecycle
 *   (create -> find -> update -> delete).
 *
 * HOW TO RUN
 *   1. Deploy/run CannaQMS with the SANDBOX keys set and METRC_WRITE_ENABLED=true.
 *      (Safe: it's the sandbox, and every real write still needs confirm=true.)
 *   2. Open CannaQMS in your browser and sign in as an ADMIN user.
 *   3. Open DevTools (F12) -> Console.
 *   4. Edit the CONFIG block below if needed (esp. externalIncomingItemName).
 *   5. Paste this whole file into the console and press Enter.
 *   6. Read the PASS/FAIL summary it prints at the end.
 *
 * SAFETY
 *   - Uses your logged-in session (credentials: 'include') — no tokens needed.
 *   - Refuses to run WRITES unless /metrc/status reports isSandbox=true.
 *   - Set CONFIG.runWrites=false to run only reads + guardrail + preview checks.
 * =========================================================================== */

(async () => {
  const CONFIG = {
    base: location.origin, // change if the API is on a different origin
    apiPrefix: "/api", // the API router is mounted at /api (see app.ts: app.use("/api", router))
    // MI sandbox licenses (from project context):
    recipientLicenseNumber: "SF-SBX-MI-6-13501", // the processor (us)
    shipperLicenseNumber: "SF-SBX-MI-15-13501", // counterparty
    licenseNumber: "SF-SBX-MI-6-13501", // used as ?licenseNumber on calls
    runWrites: true, // false = skip all real writes (reads + preview + guardrails only)
    plannedRoute: "Direct — CannaQMS sandbox soak", // Metrc requires a planned route on transfers
    // External-incoming package. Leave itemName empty to auto-pick a real
    // existing item from the facility (GET /metrc/items); set it to force one.
    externalIncomingItemName: "",
    externalIncomingQuantity: 1,
    externalIncomingUnit: "Grams",
    // Outgoing template:
    templateName: "CannaQMS Soak Template " + Date.now(),
    templateGrossWeight: 5,
    templateGrossUnit: "Grams",
  };

  const results = [];
  const log = (ok, name, detail) => {
    results.push({ ok, name });
    const tag = ok ? "%cPASS" : "%cFAIL";
    const css = ok ? "color:#16a34a;font-weight:bold" : "color:#dc2626;font-weight:bold";
    console.log(tag + "%c  " + name, css, "color:inherit", detail ?? "");
  };
  const info = (msg, obj) => console.log("%c··· " + msg, "color:#6b7280", obj ?? "");

  async function call(method, path, { query, body } = {}) {
    const url = new URL(CONFIG.base + CONFIG.apiPrefix + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  }

  const q = { licenseNumber: CONFIG.licenseNumber };
  // Metrc requires a planned route + estimated departure/arrival on transfers.
  const _depart = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
  const _arrive = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // +2h
  const _packagedDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (today)
  const externalIncomingBody = (itemName, unit) => ({
    shipperLicenseNumber: CONFIG.shipperLicenseNumber,
    shipperName: "CannaQMS Soak Shipper",
    recipientLicenseNumber: CONFIG.recipientLicenseNumber,
    plannedRoute: CONFIG.plannedRoute,
    estimatedDepartureDateTime: _depart,
    estimatedArrivalDateTime: _arrive,
    packages: [{
      itemName: itemName ?? CONFIG.externalIncomingItemName,
      quantity: CONFIG.externalIncomingQuantity,
      unitOfMeasureName: unit ?? CONFIG.externalIncomingUnit,
      packagedDate: _packagedDate,
    }],
  });
  const templateBody = () => ({
    name: CONFIG.templateName,
    recipientLicenseNumber: CONFIG.recipientLicenseNumber,
    plannedRoute: CONFIG.plannedRoute,
    estimatedDepartureDateTime: _depart,
    estimatedArrivalDateTime: _arrive,
    grossWeight: CONFIG.templateGrossWeight,
    grossUnitOfWeightName: CONFIG.templateGrossUnit,
  });

  console.log("%c=== Metrc sandbox soak starting ===", "font-size:14px;font-weight:bold");

  // --- 1. Status ------------------------------------------------------------
  const status = await call("GET", "/metrc/status");
  const st = status.json || {};
  const configured = st.configured === true; // has vendor + user keys
  const writeEnabled = st.writeEnabled === true; // METRC_WRITE_ENABLED=true
  log(status.status === 200, "status: endpoint reachable", st);
  log(st.isSandbox === true, "status: pointing at SANDBOX");
  info("configured =", configured);
  info("writeEnabled =", writeEnabled);

  if (!configured) {
    console.warn(
      "This deployment has NO Metrc keys set (hasVendorKey/hasUserKey false). " +
      "Live reads and real writes are unavailable until METRC_VENDOR_KEY + METRC_USER_KEY are set. " +
      "Preview + guardrail checks still run and are the meaningful ones without keys.",
    );
  }
  if (CONFIG.runWrites && st.isSandbox !== true) {
    console.warn("Refusing to run WRITES: /metrc/status says this is NOT the sandbox. Set runWrites=false to run read-only.");
    CONFIG.runWrites = false;
  }
  if (CONFIG.runWrites && !writeEnabled) {
    console.warn("METRC_WRITE_ENABLED is not true — skipping real writes (they would correctly 403). Set it true on the sandbox to exercise writes.");
    CONFIG.runWrites = false;
  }

  // --- 2. Reads (require keys) ----------------------------------------------
  if (!configured) {
    info("skipping live reads — no Metrc keys configured on this deployment");
  } else {
    const fac = await call("GET", "/metrc/facilities");
    log(fac.status === 200 && fac.json?.ok === true && (fac.json.count ?? 0) > 0, "facilities: returns >=1 facility", { count: fac.json?.count });

    const types = await call("GET", "/metrc/transfers/types", { query: q });
    const typeNames = (types.json?.data?.Data || []).map((t) => t.Name);
    log(types.json?.ok === true, "transfer types: ok");
    log(typeNames.includes("External Cannabinoids"), "transfer types: 'External Cannabinoids' present");
    info("transfer type names", typeNames);

    for (const kind of ["incoming", "outgoing", "rejected"]) {
      const r = await call("GET", "/metrc/transfers/" + kind, { query: q });
      log(r.json?.ok === true, "transfers/" + kind + ": ok (200)");
    }
    const templatesList0 = await call("GET", "/metrc/templates/outgoing", { query: q });
    log(templatesList0.json?.ok === true, "templates/outgoing: ok");
  }

  // --- 3. Guardrails --------------------------------------------------------
  // With the switch OFF an unconfirmed write is blocked at 403 (switch checked
  // first); with the switch ON it reaches the confirmation gate and returns 428.
  const expectBlock = writeEnabled ? 428 : 403;
  const noConfirm = await call("POST", "/metrc/transfers/external-incoming", { query: q, body: externalIncomingBody() });
  const guardOk = noConfirm.status === expectBlock && (writeEnabled ? noConfirm.json?.needsConfirmation === true : true);
  log(guardOk, "guardrail: unconfirmed write blocked (" + expectBlock + (writeEnabled ? " needsConfirmation" : " switch off") + ")", { status: noConfirm.status });

  // Bad body must be rejected with 400 (send dryRun so the switch isn't the blocker).
  const badBody = await call("POST", "/metrc/transfers/external-incoming", { query: q, body: { dryRun: true } });
  log(badBody.status === 400, "guardrail: missing required fields -> 400", { status: badBody.status });

  // --- 4. Dry-run previews (no Metrc call) ----------------------------------
  const previewEI = await call("POST", "/metrc/transfers/external-incoming", { query: q, body: { ...externalIncomingBody(), dryRun: true } });
  const eiObj = previewEI.json?.wouldSend?.body?.[0];
  log(previewEI.json?.dryRun === true, "preview external-incoming: dryRun echoed");
  log(eiObj?.TransferTypeName === "External Cannabinoids", "preview external-incoming: TransferTypeName at top level");
  log(eiObj?.ExternalId === null, "preview external-incoming: ExternalId is null");
  info("wouldSend (external incoming)", previewEI.json?.wouldSend);

  const previewTpl = await call("POST", "/metrc/templates/outgoing", { query: q, body: { ...templateBody(), dryRun: true } });
  const tplObj = previewTpl.json?.wouldSend?.body?.[0];
  log(previewTpl.json?.dryRun === true, "preview template: dryRun echoed");
  log(tplObj?.Destinations?.[0]?.GrossWeight === CONFIG.templateGrossWeight, "preview template: destination GrossWeight set");

  // --- 5. Confirmed write lifecycle -----------------------------------------
  if (!CONFIG.runWrites) {
    console.log("%c(writes skipped — runWrites=false or not sandbox)", "color:#6b7280");
  } else {
    // Discover a real existing facility item to reference (unless one is set in CONFIG).
    let soakItemName = CONFIG.externalIncomingItemName;
    let soakItemUnit = CONFIG.externalIncomingUnit;
    if (!soakItemName) {
      const items = await call("GET", "/metrc/items", { query: q });
      const d = items.json?.data;
      const arr = Array.isArray(d) ? d : d?.Data || []; // handle bare-array OR paged
      const first = arr[0];
      soakItemName = first?.Name || "";
      if (first?.UnitOfMeasureName) soakItemUnit = first.UnitOfMeasureName;
      log(!!soakItemName, "discovered an existing facility item to use", { name: soakItemName, unit: soakItemUnit, count: arr.length });
      if (!soakItemName) console.log("%c/metrc/items raw response:", "color:#f59e0b", "HTTP " + items.status + " " + JSON.stringify(items.json));
    }

    // 5a. Create external incoming (empty 200 = success).
    const createEI = await call("POST", "/metrc/transfers/external-incoming", { query: q, body: { ...externalIncomingBody(soakItemName, soakItemUnit), confirm: true } });
    log(createEI.json?.ok === true, "WRITE create external-incoming: ok", { metrc: createEI.json?.metrcStatus, error: createEI.json?.error });

    // 5b. Find it via GET incoming (newest matching our shipper).
    let newId = null;
    if (createEI.json?.ok) {
      // Metrc list search can lag a write by a moment — retry a few times.
      for (let i = 0; i < 4 && newId == null; i++) {
        if (i) await new Promise((r) => setTimeout(r, 1500));
        const incoming = await call("GET", "/metrc/transfers/incoming", { query: q });
        const mine = (incoming.json?.data?.Data || [])
          .filter((t) => t.ShipperFacilityLicenseNumber === CONFIG.shipperLicenseNumber)
          .sort((a, b) => b.Id - a.Id);
        newId = mine[0]?.Id ?? null;
      }
      log(newId != null, "WRITE find created transfer via GET incoming", { newId });
    }

    // 5c. Update it (confirmed).
    if (newId != null) {
      const upd = await call("PUT", "/metrc/transfers/external-incoming/" + newId, { query: q, body: { ...externalIncomingBody(soakItemName, soakItemUnit), confirm: true } });
      log(upd.json?.ok === true, "WRITE update external-incoming (confirmed): ok", { metrc: upd.json?.metrcStatus, error: upd.json?.error });

      // 5d. Delete it (confirmed) — leaves the sandbox clean.
      const del = await call("DELETE", "/metrc/transfers/external-incoming/" + newId, { query: { ...q, confirm: "true" } });
      log(del.json?.ok === true, "WRITE delete external-incoming (confirmed): ok", { metrc: del.json?.metrcStatus, error: del.json?.error });
    }

    // 5e. Template create + find + update (no delete endpoint for templates).
    const createTpl = await call("POST", "/metrc/templates/outgoing", { query: q, body: { ...templateBody(), confirm: true } });
    log(createTpl.json?.ok === true, "WRITE create template (confirmed): ok", { metrc: createTpl.json?.metrcStatus, error: createTpl.json?.error });
    if (createTpl.json?.ok) {
      let tpl = null;
      for (let i = 0; i < 4 && tpl == null; i++) {
        if (i) await new Promise((r) => setTimeout(r, 1500));
        const list = await call("GET", "/metrc/templates/outgoing", { query: q });
        tpl = (list.json?.data?.Data || []).find((t) => t.Name === CONFIG.templateName) || null;
      }
      log(tpl != null, "WRITE find created template via GET", { id: tpl?.Id });
      if (tpl?.Id != null) {
        const updTpl = await call("PUT", "/metrc/templates/outgoing/" + tpl.Id, { query: q, body: { ...templateBody(), confirm: true } });
        log(updTpl.json?.ok === true, "WRITE update template (confirmed): ok", { metrc: updTpl.json?.metrcStatus, error: updTpl.json?.error });
      }
    }
  }

  // --- Summary --------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(
    "%c=== Soak complete: " + passed + " passed, " + failed + " failed ===",
    "font-size:14px;font-weight:bold;color:" + (failed ? "#dc2626" : "#16a34a"),
  );
  if (failed) console.log("Failed checks:", results.filter((r) => !r.ok).map((r) => r.name));
  return { passed, failed };
})();
