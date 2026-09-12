// ---------------------------------------------------------------------------
// Metrc v2 — Catalog reads (Strain / Item / Package) + wholesale diagnostic
// ---------------------------------------------------------------------------
//
// Get-by-id reads for the catalog entities, plus diagnoseWholesaleAccess(),
// which turns the confusing "200 on packages, 401 on wholesale" symptom into a
// clear, actionable message about the missing "View Wholesale" key grant.
// ---------------------------------------------------------------------------

import { metrcGet, metrcPost, getMetrcConfig, type MetrcResult } from "./metrcClient";
import { MetrcPaths } from "./metrcEndpoints";
import { getDeliveryPackages, getDeliveryPackagesWholesale, type MetrcPaged } from "./metrcTransfers";

export type MetrcStrain = {
  Id: number;
  Name: string;
  IndicaPercentage: number;
  SativaPercentage: number;
  [k: string]: unknown;
};

export type MetrcItem = {
  Id: number;
  Name: string;
  ProductCategoryName: string;
  UnitOfMeasureName: string;
  [k: string]: unknown;
};

export type MetrcPackage = {
  Id: number;
  Label: string;
  Quantity: number;
  UnitOfMeasureName: string;
  PackagedDate: string;
  IsFinished: boolean;
  [k: string]: unknown;
};

// Resolve the license for a Metrc call: an explicit per-call value wins,
// otherwise fall back to the configured METRC_LICENSE_NUMBER. Without this
// fallback, any read whose caller didn't pass a license went out to Metrc with
// no licenseNumber and 404'd, even though the facility license was configured.
function license(explicit?: string): string | undefined {
  return explicit ?? getMetrcConfig()?.licenseNumber ?? undefined;
}

export function getStrain(id: number | string, licenseNumber?: string): Promise<MetrcResult<MetrcStrain>> {
  return metrcGet(MetrcPaths.strainById(id), { query: { licenseNumber: license(licenseNumber) } });
}

export function getItem(id: number | string, licenseNumber?: string): Promise<MetrcResult<MetrcItem>> {
  return metrcGet(MetrcPaths.itemById(id), { query: { licenseNumber: license(licenseNumber) } });
}

/**
 * List the facility's ACTIVE items — what the create-package dialog's Item picker
 * reads and what transfers reference by name.
 *
 * CRITICAL (verified live in the MI sandbox 2026-07-18): `/items/v2/active`
 * REQUIRES a `lastModifiedStart`/`lastModifiedEnd` window and returns 404
 * "Not Found" without a VALID one (unlike `/packages/v2/active`, which needs none).
 * This was the real reason the Item picker showed a text-box fallback — not paging.
 *
 * Window rules (all verified live in the MI sandbox 2026-07-18): whole-second ISO
 * (no fractional seconds), span safely UNDER 24h (Metrc caps it). The window is a
 * required parameter, not a strict filter — a ~23h window returns the WHOLE active
 * catalog (items last touched weeks earlier still come back), all in one page.
 *
 * DO NOT route this through metrcGetAllPages: adding `pageNumber`/`pageSize` on top
 * of the window makes THIS endpoint 404 (proven via the /metrc/debug/items-probe
 * diagnostic — a direct windowed read returns 200 + all items, the paged variant
 * 404s). Items come back in a single page anyway, so a plain windowed metrcGet is
 * both correct and what Metrc actually accepts here.
 */
export async function getActiveItems(licenseNumber?: string): Promise<MetrcResult<MetrcPaged<MetrcItem>>> {
  const end = new Date();
  const start = new Date(end.getTime() - 23 * 60 * 60 * 1000); // ~23h < Metrc's 24h cap
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z"); // drop milliseconds
  const direct = await metrcGet<MetrcPaged<MetrcItem>>(MetrcPaths.itemsActive, {
    query: {
      licenseNumber: license(licenseNumber),
      lastModifiedStart: iso(start),
      lastModifiedEnd: iso(end),
    },
  });
  if (!direct.ok) return direct;

  const byName = new Map<string, MetrcItem>();
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const it = raw as MetrcItem | undefined;
      const name = typeof it?.Name === "string" ? it.Name.trim() : "";
      if (it && name && !byName.has(name)) byName.set(name, it);
    }
  };
  collect(direct.data?.Data);

  // Metrc's active-items endpoint is filtered by lastModified and caps the window
  // at 24 hours, so it only ever answers "what changed yesterday" — an item created
  // weeks ago (by hand in Metrc, or by an earlier Postman call) is invisible to a
  // single window even though it is perfectly active. That empty list is what
  // forces the operator to type an item name and guess the spelling, with Metrc
  // rejecting the guess only after the whole form has been signed.
  //
  // So walk the window backwards a fortnight, one day at a time, and union the
  // results. Each call is the same shape Metrc already accepts (windowed, unpaged
  // — see the note above about pageNumber 404ing this endpoint).
  const DAYS_BACK = 14;
  for (let d = 1; d <= DAYS_BACK; d++) {
    const wEnd = new Date(end.getTime() - d * 24 * 60 * 60 * 1000);
    const wStart = new Date(wEnd.getTime() - 23 * 60 * 60 * 1000);
    const page = await metrcGet<MetrcPaged<MetrcItem>>(MetrcPaths.itemsActive, {
      query: {
        licenseNumber: license(licenseNumber),
        lastModifiedStart: iso(wStart),
        lastModifiedEnd: iso(wEnd),
      },
    });
    if (page.ok) collect(page.data?.Data);
  }

  if (byName.size > 0) {
    return { ok: true, status: direct.status, data: { ...(direct.data ?? {}), Data: [...byName.values()] } as MetrcPaged<MetrcItem> };
  }

  // Metrc's active-items endpoint is filtered by lastModified and caps the window
  // at 24 hours, so an item that has not been TOUCHED since yesterday simply does
  // not come back — the list reads as "this facility has no items" even when its
  // packages are plainly made of them. That empty list is what forces the operator
  // to type an item name by hand and guess at the spelling, and a wrong guess is
  // rejected by Metrc at the end of a long form.
  //
  // The facility's active PACKAGES each carry their own Item object, and packages
  // are not lastModified-filtered, so they are a truthful second source for the
  // same catalogue. Fall back to the distinct items those packages are made of.
  const pkgs = await getActivePackages(licenseNumber);
  if (!pkgs.ok) return direct;
  const pkgRows = Array.isArray((pkgs.data as MetrcPaged<{ Item?: MetrcItem }>)?.Data)
    ? (pkgs.data as MetrcPaged<{ Item?: MetrcItem }>).Data
    : [];
  const seen = new Map<string, MetrcItem>();
  for (const p of pkgRows) {
    const it = p?.Item;
    const name = typeof it?.Name === "string" ? it.Name.trim() : "";
    if (it && name && !seen.has(name)) seen.set(name, it);
  }
  const derived = [...seen.values()];
  if (derived.length === 0) return direct;
  return { ok: true, status: direct.status, data: { ...(direct.data ?? {}), Data: derived } as MetrcPaged<MetrcItem> };
}

export function getPackage(label: string, licenseNumber?: string): Promise<MetrcResult<MetrcPackage>> {
  return metrcGet(MetrcPaths.packageByLabel(label), { query: { licenseNumber: license(licenseNumber) } });
}

/**
 * List the facility's ACTIVE packages — its on-hand inventory per Metrc
 * (finished goods + intermediates). Read-only; the CannaQMS "Finished Goods"
 * view reads this to reconcile against physical counts. Paged like active items.
 */
/** The item categories this facility allows. A new item must name one of these. */
export function getItemCategories(licenseNumber?: string): Promise<MetrcResult<unknown>> {
  return metrcGet("/items/v2/categories", { query: { licenseNumber: license(licenseNumber) } });
}

/**
 * Create items in the facility catalogue. A package can only be made of an item
 * that already exists here, so a facility with no item for a product simply
 * cannot package that product — which is the state a fresh sandbox is in.
 */
export function createItems(
  items: Array<Record<string, unknown>>,
  licenseNumber?: string,
): Promise<MetrcResult<unknown>> {
  return metrcPost("/items/v2", { query: { licenseNumber: license(licenseNumber) }, body: items });
}

/**
 * The lab test BATCHES this facility's state defines — the panel an item is
 * tested under. An item that names none cannot have a testing sample created
 * from it. ⛔ 2026-09-11: it is NOT set on the item — Metrc's own manual (Adding
 * Items, p.40-41) has no such field, and writing one is silently ignored. The
 * panel is chosen when the SAMPLE is created (Submit for Testing, p.124-126).
 * This read exists so the sample form can offer the state's real panel names.
 */
export function getLabTestBatches(licenseNumber?: string): Promise<MetrcResult<unknown>> {
  return metrcGet(MetrcPaths.labTestBatches, { query: { licenseNumber: license(licenseNumber) } });
}

export function getActivePackages(licenseNumber?: string): Promise<MetrcResult<MetrcPaged<MetrcPackage>>> {
  return metrcGet(MetrcPaths.packagesActive, { query: { licenseNumber: license(licenseNumber) } });
}

// --- Wholesale access diagnostic --------------------------------------------

export type WholesaleDiagnosis =
  | { status: "ok"; message: string }
  | { status: "missing_view_wholesale"; message: string }
  | { status: "packages_failed"; message: string }
  | { status: "unknown"; message: string };

/**
 * Runs both delivery reads for the same delivery and interprets the outcome.
 *
 * The signature we chase: `/packages` returns 200 but `.../packages/wholesale`
 * returns 401 for the SAME delivery. That is NOT a transfer-type problem — it
 * means the API user key is missing the "View Wholesale" grant, which is a
 * permission separate from "Transfers". The fix is to regenerate the user key
 * with View Wholesale = Read Only.
 */
export async function diagnoseWholesaleAccess(
  deliveryId: number | string,
  licenseNumber?: string,
): Promise<WholesaleDiagnosis> {
  const packages = await getDeliveryPackages(deliveryId, licenseNumber);
  if (!packages.ok) {
    return {
      status: "packages_failed",
      message: `Delivery packages read failed (HTTP ${packages.status}, ${packages.kind}). Resolve this before checking wholesale.`,
    };
  }

  const wholesale = await getDeliveryPackagesWholesale(deliveryId, licenseNumber);
  if (wholesale.ok) {
    return { status: "ok", message: "Wholesale access is working (both /packages and /packages/wholesale returned 200)." };
  }
  if (wholesale.kind === "unauthorized") {
    return {
      status: "missing_view_wholesale",
      message:
        "200 on /packages but 401 on /packages/wholesale for the same delivery = the API user key is missing the 'View Wholesale' grant. Regenerate the user key with View Wholesale = Read Only (it is separate from the Transfers permission).",
    };
  }
  return {
    status: "unknown",
    message: `Wholesale read failed for a non-permission reason (HTTP ${wholesale.status}, ${wholesale.kind}): ${wholesale.error}`,
  };
}
