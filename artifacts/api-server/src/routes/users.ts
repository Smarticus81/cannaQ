import { Router, type Request } from "express";
import { db } from "@workspace/db";
import { usersTable, documentsTable, trainingRecordsTable, DEPARTMENTS } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getAuth, clerkClient } from "@clerk/express";
import { getOrProvisionCurrentUser, uniqueInitials, initialsTaken } from "../lib/currentUser";

const router = Router();

async function requireAdmin(req: Request): Promise<{ ok: true; admin: { id: number; fullName: string } } | { ok: false; status: number; error: string }> {
  const actor = await getOrProvisionCurrentUser(req);
  if (!actor) return { ok: false, status: 401, error: "Unauthorized" };
  if (actor.role !== "Admin") return { ok: false, status: 403, error: "Admin role required" };
  return { ok: true, admin: { id: actor.id, fullName: actor.fullName } };
}

const DEPT_SET = new Set<string>(DEPARTMENTS);

// If `departments` is present on the body, it must be an array whose values are
// all in the canonical DEPARTMENTS list. Returns an error string, or null if OK/absent.
function validateDepartments(body: Record<string, unknown>): string | null {
  if (body.departments === undefined) return null;
  if (!Array.isArray(body.departments)) return "departments must be an array of strings.";
  const bad = body.departments.filter((d) => !DEPT_SET.has(String(d)));
  return bad.length ? `Invalid department(s): ${bad.join(", ")}. Allowed: ${DEPARTMENTS.join(", ")}.` : null;
}

// Free-text -> canonical department mapping for the one-time migration of existing
// documents/training records onto the DEPARTMENTS list. Anything not listed here
// (and not already canonical) is reported as "unmatched" and left untouched.
const DEPARTMENT_MIGRATION: Record<string, string> = {
  Quality: "Quality / Lab",
  "Quality / Lab": "Quality / Lab",
  Lab: "Quality / Lab",
  Production: "Production",
  Kitchen: "Kitchen / Edibles",
  "Kitchen / Edibles": "Kitchen / Edibles",
  Edibles: "Kitchen / Edibles",
  Extraction: "Extraction",
  "Extraction / Concentrates": "Extraction",
  Concentrates: "Extraction",
  Cultivation: "Cultivation",
  "Pre-Roll": "Production",
  "Fill / Inhalants": "Production",
  Inhalants: "Production",
  Packaging: "Packaging & Labeling",
  "Packaging & Labeling": "Packaging & Labeling",
  Labeling: "Packaging & Labeling",
  Inventory: "Inventory / Warehouse",
  Warehouse: "Inventory / Warehouse",
  "Inventory / Warehouse": "Inventory / Warehouse",
  Shipping: "Shipping / Distribution",
  Distribution: "Shipping / Distribution",
  "Shipping / Distribution": "Shipping / Distribution",
};

router.get("/users", async (req, res) => {
  try {
    // Any authenticated user can list (needed for assignee pickers across
    // modules), but anonymous callers cannot scrape the directory.
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const users = await db.select().from(usersTable).orderBy(usersTable.fullName);
    res.json(users);
  } catch (err) {
    req.log.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Failed to list users" });
  }
});

// /users/me — returns the DB user matched to the current Clerk session.
// If the Clerk user is not yet linked to a DB user, attempts to auto-link by
// matching primary email; if no email match exists, provisions a new DB user
// (default role: Quality) so newly-invited collaborators can begin contributing.
router.get("/users/me", async (req, res) => {
  try {
    // Single source of truth for provisioning. Delegates to
    // getOrProvisionCurrentUser so the bootstrap-admin allowlist and
    // case-insensitive email linking apply here too — the previous divergent
    // copy here hardcoded role "Operator" and matched email case-sensitively,
    // which both blocked the first admin and spawned duplicate accounts.
    const user = await getOrProvisionCurrentUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    res.json(user);
  } catch (err) {
    req.log.error({ err }, "Failed to get current user");
    res.status(500).json({ error: "Failed to get current user" });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const actor = await getOrProvisionCurrentUser(req);
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    const id = parseInt(req.params.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json(user);
  } catch (err) {
    req.log.error({ err }, "Failed to get user");
    res.status(500).json({ error: "Failed to get user" });
  }
});

router.post("/users", async (req, res) => {
  try {
    const guard = await requireAdmin(req);
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    const deptErr = validateDepartments((req.body ?? {}) as Record<string, unknown>);
    if (deptErr) { res.status(400).json({ error: deptErr }); return; }
    // Session 63 / 76.1 — operator initials are the displayed e-signature
    // identity, so they are REQUIRED and must be unique by house rule (21 CFR
    // Part 11 attribution). Reject a blank value, then reject a duplicate so the
    // admin picks something unambiguous (e.g. add a middle initial) rather than
    // creating a second "OP". The DB also carries a unique index as a backstop.
    const wantInitials = typeof req.body?.initials === "string" ? req.body.initials : "";
    if (!wantInitials.trim()) {
      res.status(400).json({ error: "Initials are required — they are the signing identity on every record (21 CFR Part 11)." });
      return;
    }
    if (await initialsTaken(wantInitials)) {
      res.status(409).json({ error: `Initials "${wantInitials.trim().toUpperCase()}" are already in use. Choose distinct initials (e.g. add a middle initial) so signatures stay unambiguous.` });
      return;
    }
    // Session 70 — store email lowercased+trimmed (mirrors the Clerk
    // provisioning path in currentUser.ts) so a case-variant ("Jon@x.com" vs
    // "jon@x.com") can't mint a second account that breaks Part 11 attribution.
    // Reject a case-insensitive duplicate with a clear 409 rather than letting
    // it surface as a raw unique-index violation.
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    if (typeof body.email === "string") {
      body.email = body.email.trim().toLowerCase();
      const [dup] = await db.select({ id: usersTable.id, fullName: usersTable.fullName, active: usersTable.active })
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${body.email}`);
      // Session 70 — return the existing user's id/name so the client can offer
      // "edit them instead" instead of a dead-end error (the account is often
      // already there from Clerk auto-provisioning on first sign-in).
      if (dup) {
        res.status(409).json({
          error: `A user with email "${body.email as string}" already exists.`,
          existingUserId: dup.id,
          existingUserName: dup.fullName,
          existingUserActive: dup.active,
        });
        return;
      }
    }
    const [user] = await db.insert(usersTable).values(body as never).returning();
    res.status(201).json(user);
  } catch (err) {
    req.log.error({ err }, "Failed to create user");
    res.status(500).json({ error: "Failed to create user" });
  }
});

router.patch("/users/:id", async (req, res) => {
  try {
    const guard = await requireAdmin(req);
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    const id = parseInt(req.params.id);
    const deptErr = validateDepartments((req.body ?? {}) as Record<string, unknown>);
    if (deptErr) { res.status(400).json({ error: deptErr }); return; }
    // Session 63 / 76.1 — if this PATCH touches initials, they must stay present
    // and unique (excluding the user being edited so re-saving the same value is
    // fine). Initials are the Part 11 signing identity, so clearing them is not
    // allowed and a duplicate is rejected.
    if (typeof req.body?.initials === "string") {
      if (!req.body.initials.trim()) {
        res.status(400).json({ error: "Initials are required — they are the signing identity on every record (21 CFR Part 11)." });
        return;
      }
      if (await initialsTaken(req.body.initials, id)) {
        res.status(409).json({ error: `Initials "${req.body.initials.trim().toUpperCase()}" are already in use. Choose distinct initials so signatures stay unambiguous.` });
        return;
      }
    }
    // Session 70 — normalize email on edit and block a case-insensitive
    // collision with a DIFFERENT user (excluding self so re-saving is fine).
    const patch = { ...(req.body ?? {}), updatedAt: new Date() } as Record<string, unknown>;
    if (typeof patch.email === "string") {
      patch.email = (patch.email as string).trim().toLowerCase();
      const [dup] = await db.select({ id: usersTable.id }).from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${patch.email}`);
      if (dup && dup.id !== id) { res.status(409).json({ error: `Another user already uses email "${patch.email as string}".` }); return; }
    }
    const [user] = await db.update(usersTable).set(patch as never).where(eq(usersTable.id, id)).returning();
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json(user);
  } catch (err) {
    req.log.error({ err }, "Failed to update user");
    res.status(500).json({ error: "Failed to update user" });
  }
});

// One-time migration: map existing free-text `department` values on documents and
// training records onto the canonical DEPARTMENTS list. Admin-only. Defaults to a
// DRY RUN (returns proposed changes without writing); pass { dryRun: false } to apply.
// Values already canonical are left alone; values with no known mapping are returned
// under `unmatched` and NOT changed.
router.post("/admin/migrate-departments", async (req, res) => {
  try {
    const guard = await requireAdmin(req);
    if (!guard.ok) { res.status(guard.status).json({ error: guard.error }); return; }
    const dryRun = (req.body?.dryRun ?? true) !== false;

    const plan = (current: string | null): { to: string } | { unmatched: true } | null => {
      if (!current || !current.trim()) return null;
      const key = current.trim();
      if (DEPT_SET.has(key)) return null; // already canonical
      const mapped = DEPARTMENT_MIGRATION[key];
      return mapped ? { to: mapped } : { unmatched: true };
    };

    const changes: { table: string; id: number; from: string; to: string }[] = [];
    const unmatched: { table: string; id: number; value: string }[] = [];

    const docs = await db.select({ id: documentsTable.id, department: documentsTable.department }).from(documentsTable);
    for (const d of docs) {
      const p = plan(d.department);
      if (!p) continue;
      if ("unmatched" in p) unmatched.push({ table: "documents", id: d.id, value: d.department as string });
      else changes.push({ table: "documents", id: d.id, from: d.department as string, to: p.to });
    }

    const trs = await db.select({ id: trainingRecordsTable.id, department: trainingRecordsTable.department }).from(trainingRecordsTable);
    for (const t of trs) {
      const p = plan(t.department);
      if (!p) continue;
      if ("unmatched" in p) unmatched.push({ table: "training_records", id: t.id, value: t.department as string });
      else changes.push({ table: "training_records", id: t.id, from: t.department as string, to: p.to });
    }

    if (!dryRun) {
      for (const c of changes) {
        if (c.table === "documents") {
          await db.update(documentsTable).set({ department: c.to, updatedAt: new Date() }).where(eq(documentsTable.id, c.id));
        } else {
          await db.update(trainingRecordsTable).set({ department: c.to, updatedAt: new Date() }).where(eq(trainingRecordsTable.id, c.id));
        }
      }
    }

    res.json({
      mode: dryRun ? "DRY-RUN (no changes written)" : "APPLIED",
      changeCount: changes.length,
      changes,
      unmatchedCount: unmatched.length,
      unmatched,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to migrate departments");
    res.status(500).json({ error: "Failed to migrate departments" });
  }
});

export default router;
