// Cross-entity record search (Session 71, PR 1.5).
//
// Powers the "?" help popover's search box when it jumps to actual records
// (not just help topics). One GET /search?q= fans out across the main record
// types with case-insensitive ilike matches on each type's human-facing
// columns, and returns a flat, typed result list the frontend renders in a
// "Records" group. Each entity is queried in its own try/catch so a column
// that doesn't exist on an older database degrades that one type to empty
// rather than failing the whole search (we've been bitten by schema drift
// before — see Session 43 resync notes).

import { Router } from "express";
import { db } from "@workspace/db";
import {
  suppliersTable,
  batchRecordsTable,
  lotsTable,
  documentsTable,
  nonConformancesTable,
  complaintsTable,
  fieldActionsTable,
  capasTable,
  recipesTable,
} from "@workspace/db";
import { or, ilike, isNull, and } from "drizzle-orm";

const router = Router();

export type SearchResult = {
  type: string;       // machine type, e.g. "supplier"
  typeLabel: string;  // display group, e.g. "Suppliers"
  id: number;
  label: string;      // primary line (record number or name)
  sublabel?: string;  // secondary line
  route: string;      // where to navigate, e.g. "/suppliers/12"
};

const PER_TYPE_LIMIT = 5;
const TOTAL_LIMIT = 24;

// Escape the user's term so % and _ are treated literally, not as ilike
// wildcards. Drizzle binds the value as a parameter, so this is purely about
// wildcard semantics, not SQL-injection (which binding already prevents).
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

router.get("/search", async (req, res) => {
  try {
    const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (raw.length < 2) {
      res.json({ results: [] as SearchResult[] });
      return;
    }
    const term = likeTerm(raw);

    // Each entry returns up to PER_TYPE_LIMIT results; a failure in one is
    // swallowed so the rest of the search still returns.
    const safe = async (fn: () => Promise<SearchResult[]>): Promise<SearchResult[]> => {
      try { return await fn(); } catch (err) { req.log.error({ err }, "search: entity query failed"); return []; }
    };

    const [
      suppliers, batches, lots, documents, ncs, complaints, fieldActions, capas, recipes,
    ] = await Promise.all([
      safe(async () =>
        (await db.select({
          id: suppliersTable.id,
          name: suppliersTable.supplierName,
          type: suppliersTable.supplierType,
          status: suppliersTable.status,
        })
          .from(suppliersTable)
          .where(and(
            isNull(suppliersTable.cancelledAt),
            or(
              ilike(suppliersTable.supplierName, term),
              ilike(suppliersTable.licenseNumber, term),
              ilike(suppliersTable.contactPerson, term),
            ),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "supplier", typeLabel: "Suppliers", id: r.id,
          label: r.name, sublabel: [r.type, r.status].filter(Boolean).join(" · "),
          route: `/suppliers/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: batchRecordsTable.id,
          batchNumber: batchRecordsTable.batchNumber,
          productName: batchRecordsTable.productName,
          strainName: batchRecordsTable.strainName,
        })
          .from(batchRecordsTable)
          .where(or(
            ilike(batchRecordsTable.batchNumber, term),
            ilike(batchRecordsTable.productName, term),
            ilike(batchRecordsTable.strainName, term),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "batch", typeLabel: "Batches", id: r.id,
          label: r.batchNumber, sublabel: [r.productName, r.strainName].filter(Boolean).join(" · "),
          route: `/batches/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: lotsTable.id,
          lotNumber: lotsTable.lotNumber,
          itemName: lotsTable.itemName,
        })
          .from(lotsTable)
          .where(or(
            ilike(lotsTable.lotNumber, term),
            ilike(lotsTable.itemName, term),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "lot", typeLabel: "Lots", id: r.id,
          label: r.lotNumber ?? r.itemName, sublabel: r.itemName,
          route: `/lots/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: documentsTable.id,
          docNumber: documentsTable.docNumber,
          title: documentsTable.title,
        })
          .from(documentsTable)
          .where(and(
            isNull(documentsTable.cancelledAt),
            or(
              ilike(documentsTable.docNumber, term),
              ilike(documentsTable.title, term),
            ),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "document", typeLabel: "Documents", id: r.id,
          label: r.docNumber, sublabel: r.title,
          route: `/documents/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: nonConformancesTable.id,
          ncNumber: nonConformancesTable.ncNumber,
          title: nonConformancesTable.title,
        })
          .from(nonConformancesTable)
          .where(and(
            isNull(nonConformancesTable.cancelledAt),
            or(
              ilike(nonConformancesTable.ncNumber, term),
              ilike(nonConformancesTable.title, term),
            ),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "nc", typeLabel: "Non-Conformances", id: r.id,
          label: r.ncNumber, sublabel: r.title,
          route: `/non-conformances/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: complaintsTable.id,
          complaintNumber: complaintsTable.complaintNumber,
          productName: complaintsTable.productName,
          customerName: complaintsTable.customerName,
        })
          .from(complaintsTable)
          .where(and(
            isNull(complaintsTable.cancelledAt),
            or(
              ilike(complaintsTable.complaintNumber, term),
              ilike(complaintsTable.productName, term),
              ilike(complaintsTable.customerName, term),
            ),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "complaint", typeLabel: "Complaints", id: r.id,
          label: r.complaintNumber, sublabel: [r.productName, r.customerName].filter(Boolean).join(" · "),
          route: `/complaints/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: fieldActionsTable.id,
          faNumber: fieldActionsTable.faNumber,
          title: fieldActionsTable.title,
        })
          .from(fieldActionsTable)
          .where(or(
            ilike(fieldActionsTable.faNumber, term),
            ilike(fieldActionsTable.title, term),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "field_action", typeLabel: "Field Actions", id: r.id,
          label: r.faNumber, sublabel: r.title,
          route: `/field-actions/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: capasTable.id,
          capaNumber: capasTable.capaNumber,
          title: capasTable.title,
        })
          .from(capasTable)
          .where(or(
            ilike(capasTable.capaNumber, term),
            ilike(capasTable.title, term),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "capa", typeLabel: "CAPA", id: r.id,
          label: r.capaNumber, sublabel: r.title,
          route: `/capas/${r.id}`,
        }))
      ),
      safe(async () =>
        (await db.select({
          id: recipesTable.id,
          productName: recipesTable.productName,
          productType: recipesTable.productType,
        })
          .from(recipesTable)
          .where(or(
            ilike(recipesTable.productName, term),
            ilike(recipesTable.productType, term),
          ))
          .limit(PER_TYPE_LIMIT)
        ).map((r) => ({
          type: "recipe", typeLabel: "Recipes", id: r.id,
          label: r.productName, sublabel: r.productType,
          route: `/recipes/${r.id}`,
        }))
      ),
    ]);

    const results: SearchResult[] = [
      ...suppliers, ...batches, ...lots, ...documents, ...ncs,
      ...complaints, ...fieldActions, ...capas, ...recipes,
    ].slice(0, TOTAL_LIMIT);

    res.json({ results });
  } catch (err) {
    req.log.error({ err }, "Failed to run search");
    res.status(500).json({ error: "Failed to run search" });
  }
});

export default router;
