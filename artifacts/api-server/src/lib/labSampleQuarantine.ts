// ---------------------------------------------------------------------------
// Lab-sample quarantine — R 420.304(2)(k) / R 420.303a(2)
// ---------------------------------------------------------------------------
//
// Michigan, verbatim: "If a testing sample is collected from a marihuana
// business for testing in the statewide monitoring system, that marihuana
// business shall quarantine the marihuana product that is undergoing the
// testing from any other marihuana product at the marihuana business. The
// quarantined marihuana product may not be packaged, transferred, or sold
// until passing test results are entered into the statewide monitoring
// system." R 420.303a(2) says the same for a producer of final-form product.
//
// So once a sample has been COLLECTED, the batch it came from is frozen until
// that sample's result reads Pass. A Fail keeps it frozen — failed product is
// not shippable, it is destroyed under R 420.304(6).
//
// ⛔ The trigger is `sample_collected_at`, NOT the older phase="pre_test". Rows
// written before 2026-09-08 have no collection record and must not be swept
// into a gate that did not exist when they were entered.
import { db, batchTestingTable } from "@workspace/db";
import { and, eq, isNotNull } from "drizzle-orm";

export type OpenLabSample = {
  id: number;
  sequenceNumber: number;
  testResult: string;
  collectedAt: Date | null;
};

/** Every collected sample on this batch that has not come back Pass. */
export async function openLabSamples(batchId: number): Promise<OpenLabSample[]> {
  const rows = await db
    .select({
      id: batchTestingTable.id,
      sequenceNumber: batchTestingTable.sequenceNumber,
      testResult: batchTestingTable.testResult,
      collectedAt: batchTestingTable.sampleCollectedAt,
    })
    .from(batchTestingTable)
    .where(and(eq(batchTestingTable.batchId, batchId), isNotNull(batchTestingTable.sampleCollectedAt)));
  return rows.filter((r) => (r.testResult ?? "Pending") !== "Pass");
}

/**
 * The refusal message for an action the quarantine forbids, or null when the
 * batch is clear. `action` completes the sentence "This batch cannot be …".
 */
export async function labSampleQuarantineBlock(batchId: number, action: string): Promise<string | null> {
  const open = await openLabSamples(batchId);
  if (open.length === 0) return null;
  const failed = open.filter((o) => o.testResult === "Fail");
  if (failed.length > 0) {
    return `This batch cannot be ${action}. Lab sample #${failed[0].sequenceNumber} came back Fail. Under R 420.304(6) a failed batch is destroyed (or remediated under R 420.306), not released.`;
  }
  return `This batch cannot be ${action} while a lab sample is out. R 420.304(2)(k) quarantines sampled product until passing results are recorded. Record the passing result on sample #${open[0].sequenceNumber} first.`;
}
