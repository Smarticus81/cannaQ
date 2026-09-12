// A vendor/manufacturer lot number is an OPTIONAL attribute — packaging has
// none, and the same mfg lot can be received more than once (the lot's real key
// is its id). Show it when set, otherwise a dash. (No synthetic placeholder.)
export function displayLotNumber(lotNumber: string | null | undefined, fallback = "—"): string {
  return (lotNumber ?? "").trim() || fallback;
}
export function isBlankLotNumber(lotNumber: string | null | undefined): boolean {
  return !(lotNumber ?? "").trim();
}
