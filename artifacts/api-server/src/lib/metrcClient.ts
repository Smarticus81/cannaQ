import { facilityIdStore, getPrimaryFacilityId } from "./recordNumber";
import { logger } from "./logger";
import type { MetrcPaged } from "./metrcTransfers";

// ---------------------------------------------------------------------------
// Metrc integration — Phase 0: auth & connectivity foundation
// ---------------------------------------------------------------------------
//
// This is the single typed HTTP client every Metrc read (Phase 1) and, later,
// every write-back (Phase 3) goes through. Per the 06-27 build plan, Phase 0's
// only job is: authenticate against the sandbox and return `GET /facilities/v2`,
// because that call reports the facilities + per-facility permissions the state
// granted, and everything else keys off it.
//
// Auth model (validated live in the sandbox, 06-27): "normal" data endpoints —
// facilities, packages, lab tests, transfers — use HTTP **Basic auth**, where
// username = Vendor key and password = API User key. (The `/sandbox/` helper
// endpoints use an `x-metrc-key` header instead; those are Postman-only seeding
// helpers and are intentionally NOT modeled here.)
//
// Secrets NEVER live in the repo. They come from the environment:
//   METRC_VENDOR_KEY      — your vendor key (full access in sandbox)
//   METRC_USER_KEY        — the API user key from integrator/setup
//   METRC_BASE_URL        — defaults to the Michigan sandbox host
//   METRC_LICENSE_NUMBER  — processor license (used by package/transfer calls,
//                           not required for /facilities)
// ---------------------------------------------------------------------------

const SANDBOX_MI_HOST = "https://sandbox-api-mi.metrc.com";

/**
 * Normalizes the configured base URL and FORCES an https scheme.
 *
 * Why this matters (learned the hard way in the sandbox, 06-29→07-01): if the
 * host is stored scheme-less ("sandbox-api-mi.metrc.com") or as http, Metrc
 * 301-redirects http→https, and some HTTP clients follow that redirect by
 * DOWNGRADING a POST/PUT into a GET — which surfaces as a baffling
 * "405 GET not supported" on a request you sent as POST. Guaranteeing https up
 * front means the write verbs are never silently turned into reads.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  let url = (raw ?? SANDBOX_MI_HOST).trim().replace(/\/+$/, "");
  if (!url) url = SANDBOX_MI_HOST;
  if (/^http:\/\//i.test(url)) {
    url = url.replace(/^http:\/\//i, "https://");
  } else if (!/^https:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

export type MetrcConfig = {
  baseUrl: string;
  vendorKey: string;
  userKey: string;
  licenseNumber: string | null;
};

// ---------------------------------------------------------------------------
// WHERE THE CONNECTION COMES FROM (multi-facility Phase 1, slice 3 — 2026-08-28)
//
// A facility IS a licence and METRC issues credentials per licence, so the
// connection belongs to the facility record, not to an environment variable
// shared by whatever the server happens to be running. The host differs by state
// as well — Michigan sandbox is not the Missouri host — so this is a per-facility
// client, not a per-process one.
//
// The facility's connection is held IN MEMORY rather than read from the database
// on each call, because getMetrcConfig() is synchronous and 43 call sites depend on
// that. It is loaded at boot and refreshed when someone saves it, which is the same
// arrangement the facility time zone already uses.
//
// ⛔ PER FACILITY, FROM PHASE 4 (2026-08-28). Every connection is loaded at boot into
// a map keyed by facility, and a request picks the one for the site it is acting for.
// The request does not have to pass it: the same store that carries the request's
// database connection carries its facility id, so all forty-odd call sites go on
// asking for "the connection" and get the right one. A caller that has to remember
// which plant it is talking to is a caller that will eventually forget, and the
// forgetting would mean writing one plant's packages into another plant's licence.
//
// Work outside a request — boot, the scheduler — has no facility in the store and
// falls back to the primary facility, then to the environment.
//
// The METRC_* environment variables remain the fallback, per field, so a facility
// that has not been filled in behaves precisely as it did before this existed.
// ---------------------------------------------------------------------------
export type FacilityMetrcConfig = {
  baseUrl: string | null;
  licenseNumber: string | null;
  vendorKey: string | null;
  userKey: string | null;
};

/** Every facility's connection, keyed by facility id. Loaded at boot, refreshed on save. */
const facilityMetrcById = new Map<number, FacilityMetrcConfig>();

// Which facility this request is acting for. One store, shared with record
// numbering (lib/recordNumber.ts) so both answer the same question the same way.

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** Record one facility's stored connection. Called at boot and whenever it is saved. */
export function setFacilityMetrcConfig(facilityId: number, cfg: FacilityMetrcConfig | null): void {
  if (!cfg) {
    facilityMetrcById.delete(facilityId);
    return;
  }
  facilityMetrcById.set(facilityId, {
    baseUrl: clean(cfg.baseUrl),
    licenseNumber: clean(cfg.licenseNumber),
    vendorKey: clean(cfg.vendorKey),
    userKey: clean(cfg.userKey),
  });
}

/** The connection for the facility this request is acting for. */
function currentFacilityMetrc(): FacilityMetrcConfig | null {
  const id = facilityIdStore.getStore() ?? getPrimaryFacilityId();
  if (id == null) return null;
  return facilityMetrcById.get(id) ?? null;
}

/** Which source each half of the connection is currently coming from. */
export function getMetrcConfigSource(): { vendorKey: string; userKey: string; baseUrl: string; licenseNumber: string } {
  const src = (facilityValue: string | null, envName: string) =>
    facilityValue ? "facility" : (process.env[envName] ?? "").trim() ? "environment" : "unset";
  return {
    vendorKey: src(currentFacilityMetrc()?.vendorKey ?? null, "METRC_VENDOR_KEY"),
    userKey: src(currentFacilityMetrc()?.userKey ?? null, "METRC_USER_KEY"),
    // The host is never really unset: with neither the facility nor the environment
    // holding one, normalizeBaseUrl() falls back to the Michigan sandbox. Saying
    // "not set" beside a host the app is plainly using reads as a fault when it is
    // not one, so that case is reported as what it is — the built-in default.
    baseUrl: src(currentFacilityMetrc()?.baseUrl ?? null, "METRC_BASE_URL") === "unset"
      ? "default"
      : src(currentFacilityMetrc()?.baseUrl ?? null, "METRC_BASE_URL"),
    licenseNumber: src(currentFacilityMetrc()?.licenseNumber ?? null, "METRC_LICENSE_NUMBER"),
  };
}

/**
 * The Metrc connection to use: the facility's stored values where set, the
 * METRC_* environment variables where not. Returns null when the two required
 * secrets (vendor + user key) are missing from BOTH, so callers can degrade
 * gracefully instead of throwing — mirrors how the AI client treats a missing key.
 *
 * Resolved field by field ON PURPOSE. A facility that has recorded only its licence
 * number keeps using the environment's keys rather than losing its connection,
 * which is what makes moving these onto the facility safe to do one field at a time.
 */
export function getMetrcConfig(): MetrcConfig | null {
  const vendorKey = currentFacilityMetrc()?.vendorKey ?? (process.env["METRC_VENDOR_KEY"] ?? "").trim();
  const userKey = currentFacilityMetrc()?.userKey ?? (process.env["METRC_USER_KEY"] ?? "").trim();
  if (!vendorKey || !userKey) return null;
  const baseUrl = normalizeBaseUrl(currentFacilityMetrc()?.baseUrl ?? process.env["METRC_BASE_URL"]);
  const licenseNumber =
    currentFacilityMetrc()?.licenseNumber ?? ((process.env["METRC_LICENSE_NUMBER"] ?? "").trim() || null);
  return { baseUrl, vendorKey, userKey, licenseNumber };
}

export function metrcConfigured(): boolean {
  return getMetrcConfig() !== null;
}

/**
 * Diagnostic config view for the in-app status panel. Reports WHICH pieces are
 * present without ever returning the secret values themselves.
 */
export function getMetrcConfigStatus(): {
  configured: boolean;
  baseUrl: string;
  isSandbox: boolean;
  hasVendorKey: boolean;
  hasUserKey: boolean;
  licenseNumber: string | null;
} {
  // Reports the connection that would ACTUALLY be used — facility first, environment
  // second — so the status panel can never disagree with the requests being sent.
  const baseUrl = normalizeBaseUrl(currentFacilityMetrc()?.baseUrl ?? process.env["METRC_BASE_URL"]);
  return {
    configured: metrcConfigured(),
    baseUrl,
    isSandbox: /sandbox/i.test(baseUrl),
    hasVendorKey: !!(currentFacilityMetrc()?.vendorKey ?? (process.env["METRC_VENDOR_KEY"] ?? "").trim()),
    hasUserKey: !!(currentFacilityMetrc()?.userKey ?? (process.env["METRC_USER_KEY"] ?? "").trim()),
    licenseNumber:
      currentFacilityMetrc()?.licenseNumber ?? ((process.env["METRC_LICENSE_NUMBER"] ?? "").trim() || null),
  };
}

// A discriminated result so callers can act on the exact outcome the Proficiency
// Evaluation cares about: a clean 200, vs a 401 (permission not enabled — the
// signal we hit on the first write attempt), vs other 4xx/5xx, vs a network/
// config failure. We never throw for an HTTP error; the shape carries it.
export type MetrcErrorKind =
  | "not_configured"
  | "unauthorized" // 401/403 — key lacks permission for this action
  | "client_error" // other 4xx
  | "server_error" // 5xx or unparseable success body
  | "network"; // DNS/timeout/connection — request never completed

export type MetrcResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; kind: MetrcErrorKind };

function basicAuthHeader(cfg: MetrcConfig): string {
  return "Basic " + Buffer.from(`${cfg.vendorKey}:${cfg.userKey}`).toString("base64");
}

const NOT_CONFIGURED: MetrcResult<never> = {
  ok: false,
  status: 0,
  kind: "not_configured",
  error: "Metrc is not configured. Set METRC_VENDOR_KEY and METRC_USER_KEY on the environment.",
};

function buildUrl(cfg: MetrcConfig, path: string, query?: Record<string, string | undefined>): URL {
  const url = new URL(cfg.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }
  }
  return url;
}

/**
 * Turns a fetch Response + its already-read body text into a MetrcResult.
 *
 * Two Metrc-specific behaviors are encoded here so every verb handles them the
 * same way:
 *  - An EMPTY body on a 2xx is success. Metrc mutations (PUT adjust/finish/
 *    unfinish, DELETE external/incoming) return 200 with no body — that is the
 *    success signal, not an error.
 *  - 401/403 means the key is authenticated but lacks the permission for THIS
 *    action. The classic case is a 200 on `/deliveries/{id}/packages` but a 401
 *    on `.../packages/wholesale` for the same delivery — the signature of a
 *    missing "View Wholesale" grant, which is a separate permission from
 *    Transfers. See diagnoseWholesaleAccess() in metrcCatalog.
 */
function interpretResponse<T>(status: number, ok: boolean, text: string, statusText: string): MetrcResult<T> {
  if (ok) {
    if (!text) return { ok: true, status, data: undefined as T };
    try {
      return { ok: true, status, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, status, kind: "server_error", error: "Metrc returned a non-JSON success body." };
    }
  }
  const kind: MetrcErrorKind =
    status === 401 || status === 403 ? "unauthorized" : status >= 500 ? "server_error" : "client_error";
  return { ok: false, status, kind, error: (text || statusText || `HTTP ${status}`).slice(0, 800) };
}

type SendOpts = { query?: Record<string, string | undefined>; body?: unknown };

async function metrcSend<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts?: SendOpts): Promise<MetrcResult<T>> {
  const cfg = getMetrcConfig();
  if (!cfg) return NOT_CONFIGURED;

  const url = buildUrl(cfg, path, opts?.query);
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(cfg),
    Accept: "application/json",
  };
  const hasBody = opts?.body !== undefined;
  if (hasBody) headers["Content-Type"] = "application/json";

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(opts?.body) : undefined,
    });
    const text = await resp.text();
    return interpretResponse<T>(resp.status, resp.ok, text, resp.statusText);
  } catch (err) {
    logger.error({ err, path, method }, "Metrc request network error");
    return { ok: false, status: 0, kind: "network", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Typed GET against Metrc with Basic auth. */
export async function metrcGet<T = unknown>(
  path: string,
  opts?: { query?: Record<string, string | undefined> },
): Promise<MetrcResult<T>> {
  return metrcSend<T>("GET", path, opts);
}

/**
 * Typed POST/PUT/DELETE against Metrc with Basic auth. Write-back verbs.
 * Bodies are serialized to JSON; a 200 with an empty body counts as success
 * (see interpretResponse). Callers pass the licenseNumber via `query`.
 */
export async function metrcPost<T = unknown>(path: string, opts?: SendOpts): Promise<MetrcResult<T>> {
  return metrcSend<T>("POST", path, opts);
}
export async function metrcPut<T = unknown>(path: string, opts?: SendOpts): Promise<MetrcResult<T>> {
  return metrcSend<T>("PUT", path, opts);
}
export async function metrcDelete<T = unknown>(path: string, opts?: SendOpts): Promise<MetrcResult<T>> {
  return metrcSend<T>("DELETE", path, opts);
}

// ---------------------------------------------------------------------------
// Paginated list reads — follow Metrc's paging to the END
// ---------------------------------------------------------------------------
//
// Metrc v2 list endpoints (packages, transfers, …) are PAGED. Where paging is
// supported this helper requests page 1, 2, 3 … until a short/empty page (or the
// reported last page) and returns ONE MetrcPaged envelope holding every record,
// so callers get the whole list instead of a truncated first page. Where paging
// is NOT supported (see the fallback below) it returns the single unpaged read.
//
// Query params: Metrc v2 uses `pageNumber` + `pageSize`. IMPORTANT (verified live
// in the MI sandbox 2026-07-18): some "active/available" endpoints —
// /items/v2/active, /tags/v2/package/available, /locations/*/active — do NOT
// accept these params and answer 404 "Not Found" when they're present, returning
// the WHOLE list in a single unpaged call instead (e.g. active packages returns
// 21 records unpaged, well past any 20 cap). So if page 1 fails, we FALL BACK to
// an unpaged read before giving up — paging must never REMOVE data. A failure on a
// LATER page just stops the loop and returns what we already collected.
// ---------------------------------------------------------------------------
/** Binary GET (e.g. a manifest PDF). Bypasses the JSON interpret path and
 *  returns the raw bytes + content-type, or an error. Basic auth like the rest. */
export async function metrcGetPdf(
  path: string,
): Promise<{ ok: true; data: Buffer; contentType: string } | { ok: false; status: number; error: string }> {
  const cfg = getMetrcConfig();
  if (!cfg) return { ok: false, status: 0, error: "Metrc is not configured." };
  try {
    const resp = await fetch(new URL(cfg.baseUrl + path), {
      method: "GET",
      headers: { Authorization: basicAuthHeader(cfg), Accept: "application/pdf" },
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, error: t || resp.statusText };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { ok: true, data: buf, contentType: resp.headers.get("content-type") ?? "application/pdf" };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function metrcGetAllPages<T = unknown>(
  path: string,
  opts?: { query?: Record<string, string | undefined>; pageSize?: number; maxPages?: number },
): Promise<MetrcResult<MetrcPaged<T>>> {
  const pageSize = Math.min(Math.max(opts?.pageSize ?? 20, 1), 20); // Metrc hard-caps at 20
  const maxPages = opts?.maxPages ?? 200; // backstop: 200 × 20 = 4000 records
  const all: T[] = [];
  let last: Record<string, unknown> = {};
  let page = 1;

  while (page <= maxPages) {
    const res = await metrcGet<Record<string, unknown>>(path, {
      query: { ...(opts?.query ?? {}), pageNumber: String(page), pageSize: String(pageSize) },
    });
    if (!res.ok) {
      if (page === 1) {
        // The endpoint may reject paging params (MI 404s /items, /tags, /locations
        // when sent pageNumber/pageSize). Retry UNPAGED — that returns the full
        // list — before surfacing the error, so paging never blanks a working read.
        const unpaged = await metrcGet<Record<string, unknown>>(path, { query: opts?.query });
        if (unpaged.ok) {
          const env = (unpaged.data && typeof unpaged.data === "object" ? unpaged.data : {}) as Record<string, unknown>;
          const dataArr = Array.isArray(env["Data"]) ? (env["Data"] as T[]) : [];
          return {
            ok: true,
            status: unpaged.status,
            data: {
              ...env,
              Data: dataArr,
              Total: dataArr.length,
              TotalRecords: typeof env["TotalRecords"] === "number" ? (env["TotalRecords"] as number) : dataArr.length,
              PageSize: dataArr.length || pageSize,
              RecordsOnPage: dataArr.length,
              Page: 1,
              TotalPages: 1,
            } as MetrcPaged<T>,
          };
        }
        return res as MetrcResult<MetrcPaged<T>>;
      }
      // A later page failing = keep what we have so one flaky page doesn't blank the list.
      break;
    }
    const env = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
    last = env;
    const dataArr = Array.isArray(env["Data"]) ? (env["Data"] as T[]) : [];
    all.push(...dataArr);

    const recordsOnPage = typeof env["RecordsOnPage"] === "number" ? (env["RecordsOnPage"] as number) : dataArr.length;
    const totalPages = typeof env["TotalPages"] === "number" ? (env["TotalPages"] as number) : undefined;
    const total =
      typeof env["Total"] === "number" ? (env["Total"] as number)
      : typeof env["TotalRecords"] === "number" ? (env["TotalRecords"] as number)
      : undefined;

    // Stop conditions (any one ends the walk): empty page, a short (last) page,
    // the reported last page, or we've collected the reported total.
    if (dataArr.length === 0) break;
    if (recordsOnPage < pageSize) break;
    if (totalPages != null && page >= totalPages) break;
    if (total != null && all.length >= total) break;
    page += 1;
  }

  const merged: MetrcPaged<T> = {
    ...last, // keep any extra Metrc envelope fields
    Data: all,
    Total: all.length,
    TotalRecords: typeof last["TotalRecords"] === "number" ? (last["TotalRecords"] as number) : all.length,
    PageSize: pageSize,
    RecordsOnPage: all.length,
    Page: 1,
    TotalPages: 1,
  };
  return { ok: true, status: 200, data: merged };
}

// ---------------------------------------------------------------------------
// GET /facilities/v2 — the Phase 0 anchor call
// ---------------------------------------------------------------------------

// Metrc's facility shape varies a little by state/version, so we type it loosely
// and read fields defensively in the summarizer. We pass the raw objects through
// to callers untouched; the summary is a convenience layer on top.
export type MetrcFacility = {
  Name?: string;
  DisplayName?: string;
  Alias?: string;
  IsManager?: boolean;
  License?: {
    Number?: string;
    LicenseType?: string;
    StartDate?: string;
    EndDate?: string;
  };
  FacilityType?: Record<string, unknown>;
  [key: string]: unknown;
};

export async function getFacilities(): Promise<MetrcResult<MetrcFacility[]>> {
  return metrcGet<MetrcFacility[]>("/facilities/v2");
}

export type FacilitySummary = {
  name: string;
  displayName: string | null;
  licenseNumber: string | null;
  licenseType: string | null;
  isManager: boolean | null;
  // FacilityType is a bag of capability booleans (CanGrowPlants, CanCreateOpeningBalance…)
  // whose exact keys differ by state. We surface the ones that are `true` so the
  // operator can eyeball which permission areas this facility has, which is what
  // the Proficiency Evaluation Permissions sheet is checking.
  capabilities: string[];
};

export function summarizeFacilities(facilities: MetrcFacility[] | undefined): FacilitySummary[] {
  if (!Array.isArray(facilities)) return [];
  return facilities.map((f) => {
    const ft = f.FacilityType && typeof f.FacilityType === "object" ? f.FacilityType : {};
    const capabilities = Object.entries(ft)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    return {
      name: (f.Name ?? f.DisplayName ?? "(unnamed)").toString(),
      displayName: f.DisplayName ? String(f.DisplayName) : null,
      licenseNumber: f.License?.Number ? String(f.License.Number) : null,
      licenseType: f.License?.LicenseType ? String(f.License.LicenseType) : null,
      isManager: typeof f.IsManager === "boolean" ? f.IsManager : null,
      capabilities,
    };
  });
}
