// ---------------------------------------------------------------------------
// State tracking-system provider abstraction — the "conduit"
// ---------------------------------------------------------------------------
//
// CannaQMS's fulfillment / inventory calls to a state seed-to-sale system
// (create finished-goods packages, read on-hand packages, list available tags)
// go through THIS interface — never a state API directly. Adding BioTrack (or
// any other state system) is then a NEW ADAPTER behind this same interface, not
// a rewrite of the fulfillment workflow or the UI.
//
// This mirrors the existing lab-results provider (`labResultsProvider.ts`). The
// provider is chosen per facility by `regulatory_config.tracing_system`
// ("METRC" | "BIOTRACK"), exactly like lab results.
//
// STATUS (2026-07-15): Metrc is implemented — it delegates to the existing
// `metric*` libs, so behavior is byte-for-byte what the routes did before.
// BioTrack is a stub that throws until it is built. Only the read-only "active
// packages" pull is routed through here so far (see routes/metrc.ts); the
// write/push path stays direct until the fulfillment redesign lands.
//
// KNOWN FOLLOW-UP: the package/tag RETURN SHAPES below are still Metrc-shaped
// (the Finished Goods screen consumes them directly). When a second provider is
// actually implemented, normalize these to a provider-neutral shape — deferred
// on purpose so we don't guess BioTrack's response format before we have its docs.
// ---------------------------------------------------------------------------

import { getActingFacilityId } from "../middlewares/facilityContext";
import { getRegulatoryRulesForFacility } from "./regulatoryRules";
import { getActivePackages as metrcGetActivePackages } from "./metrcCatalog";
import {
  createPackages as metrcCreatePackages,
  getAvailablePackageTags as metrcGetAvailableTags,
  type CreateFinishedGoodsInput,
} from "./metrcPackages";
import {
  createTemplateOutgoing as metrcCreateTemplateOutgoing,
  type TemplateOutgoingInput,
} from "./metrcTransfers";

/**
 * The set of state-tracking operations CannaQMS's fulfillment flow needs. Every
 * caller depends on THIS, not on a concrete state API, so a new state system is
 * a new implementation of this interface plus a config flag.
 */
export interface StateTrackingProvider {
  readonly name: "metrc" | "biotrack";
  /** Finished-goods on-hand — the reconciliation pull behind the Finished Goods screen. Read-only. */
  getActivePackages(licenseNumber?: string): ReturnType<typeof metrcGetActivePackages>;
  /** Create finished-goods / child packages from a tested source package (the fulfillment push). */
  createFinishedGoods(input: CreateFinishedGoodsInput, licenseNumber?: string): ReturnType<typeof metrcCreatePackages>;
  /** Unused package tags available to assign — used to validate scanned tags. */
  getAvailablePackageTags(licenseNumber?: string): ReturnType<typeof metrcGetAvailableTags>;
  /** File an outbound transfer as an outgoing TEMPLATE (Metrc v2 has no direct
   *  outgoing-transfer create — the template is the API-side manifest; a human
   *  confirms it into a live manifest in the state UI; Phase 3 watches for it). */
  createOutgoingTemplate(input: TemplateOutgoingInput, licenseNumber?: string): ReturnType<typeof metrcCreateTemplateOutgoing>;
}

/** Metrc adapter — thin delegation to the existing, sandbox-verified metrc* libs. */
class MetrcTrackingProvider implements StateTrackingProvider {
  readonly name = "metrc" as const;
  getActivePackages(licenseNumber?: string) {
    return metrcGetActivePackages(licenseNumber);
  }
  createFinishedGoods(input: CreateFinishedGoodsInput, licenseNumber?: string) {
    return metrcCreatePackages(input, licenseNumber);
  }
  getAvailablePackageTags(licenseNumber?: string) {
    return metrcGetAvailableTags(licenseNumber);
  }
  createOutgoingTemplate(input: TemplateOutgoingInput, licenseNumber?: string) {
    return metrcCreateTemplateOutgoing(input, licenseNumber);
  }
}

/** BioTrack adapter — stubbed. Implement when a BioTrack-state customer is on the table. */
class BioTrackTrackingProvider implements StateTrackingProvider {
  readonly name = "biotrack" as const;
  private notReady(): never {
    throw new Error(
      "BioTrack tracking provider is not configured yet. Set tracing_system to METRC, or implement the BioTrack adapter.",
    );
  }
  getActivePackages(_licenseNumber?: string): ReturnType<typeof metrcGetActivePackages> {
    return this.notReady();
  }
  createFinishedGoods(_input: CreateFinishedGoodsInput, _licenseNumber?: string): ReturnType<typeof metrcCreatePackages> {
    return this.notReady();
  }
  getAvailablePackageTags(_licenseNumber?: string): ReturnType<typeof metrcGetAvailableTags> {
    return this.notReady();
  }
  createOutgoingTemplate(_input: TemplateOutgoingInput, _licenseNumber?: string): ReturnType<typeof metrcCreateTemplateOutgoing> {
    return this.notReady();
  }
}

/** Choose the tracking provider from a facility's tracing-system string. Pure. */
export function getTrackingProvider(tracingSystem?: string | null): StateTrackingProvider {
  const sys = (tracingSystem ?? "METRC").trim().toUpperCase();
  if (sys === "BIOTRACK") return new BioTrackTrackingProvider();
  return new MetrcTrackingProvider();
}

/**
 * Resolve the provider for the facility this request is acting for.
 *
 * ⛔ Was `.limit(1)` on regulatory_config — the first row in the table, whatever
 * state it belonged to. A Michigan site and an Illinois site would have been
 * handed the same provider, and once one of those states is not on METRC that is
 * a write to the wrong system. Now resolved by the acting facility's state.
 */
export async function getTrackingProviderForFacility(): Promise<StateTrackingProvider> {
  const rules = getRegulatoryRulesForFacility(getActingFacilityId());
  return getTrackingProvider(rules.tracingSystem);
}
