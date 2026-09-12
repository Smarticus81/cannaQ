import type { Request } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { getAuth, clerkClient } from "@clerk/express";
import { timingSafeEqual } from "node:crypto";

export type CurrentUser = typeof usersTable.$inferSelect;

// Session 63 / 76.1 — operator initials are the displayed e-signature identity
// on batch records, co-signs, and dispositions, so by house rule (Jonathan,
// 06-22) two users may NEVER share initials — a signed record must be
// unambiguous about who acted (21 CFR Part 11 attribution). Enforced at three
// layers: this auto-provision derivation, the app-layer initialsTaken() check
// in routes/users.ts, and a DB unique index (ensureSchema.ts). Given a desired
// base ("OP"), uniqueInitials returns it if free, else the smallest free numeric
// variant ("OP2", "OP3"…) — used ONLY on the no-human auto-provision paths so
// Clerk-provisioned users can't collide (a human picking initials gets a 409
// instead and chooses something meaningful).
export async function uniqueInitials(desired: string, excludeId?: number): Promise<string> {
  const base = (desired ?? "").trim().toUpperCase().slice(0, 4) || "U";
  const rows = await db.select({ id: usersTable.id, initials: usersTable.initials }).from(usersTable);
  const taken = new Set(
    rows
      .filter((r) => excludeId == null || r.id !== excludeId)
      .map((r) => (r.initials ?? "").trim().toUpperCase()),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  }
  return `${base}${Date.now() % 1000}`;
}

// Session 63 — does any OTHER user already hold these initials? Used by the
// admin "Add User" form so a human picking initials gets a clear rejection
// (and can choose something meaningful) rather than a silent duplicate.
export async function initialsTaken(initials: string, excludeId?: number): Promise<boolean> {
  const want = (initials ?? "").trim().toUpperCase();
  if (!want) return false;
  const rows = await db.select({ id: usersTable.id, initials: usersTable.initials }).from(usersTable);
  return rows.some(
    (r) => (excludeId == null || r.id !== excludeId) && (r.initials ?? "").trim().toUpperCase() === want,
  );
}

// Email allowlist that auto-receives the Admin role on first sign-in (and on
// every subsequent sign-in, so a downgrade can't strand the bootstrap account).
// Configured via env var `BOOTSTRAP_ADMIN_EMAILS` (comma-separated). Comparison
// is case-insensitive.
function getBootstrapAdminEmails(): Set<string> {
  const raw = process.env["BOOTSTRAP_ADMIN_EMAILS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function isBootstrapAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return getBootstrapAdminEmails().has(email.toLowerCase());
}

/**
 * Returns the CannaQMS user matched to the current Clerk session, auto-linking
 * by primary email or auto-provisioning a new "Quality"-role record on first
 * login. Returns null if there is no Clerk session at all.
 *
 * Mirrors the logic in /api/users/me so any route that needs to know "who is
 * acting" can share the same provisioning behavior.
 */
// ---------------------------------------------------------------------------
// Service token — machine access without a browser session (2026-09-08)
// ---------------------------------------------------------------------------
//
// Every tool that works on this app has had to ride inside a signed-in browser
// session, which in practice means a Chrome extension that drops every few
// minutes; each drop costs Jonathan a round trip and a re-approval. A service
// token is the ordinary answer: a long secret set in the environment, presented
// as a header, checked in constant time.
//
// It is NOT an anonymous back door. The token resolves to a REAL, named user
// row, so every role gate, every 21 CFR Part 11 signature and every audit line
// downstream behaves exactly as it does for that person signed in at a keyboard
// — the record still says who acted. Both variables must be set, and if the
// named account is missing or inactive the request is simply unauthenticated:
// it never falls back to "some admin".
//
//   SERVICE_API_TOKEN       the secret (32+ chars; rotate it to revoke access)
//   SERVICE_API_USER_EMAIL  the account the token acts as
//
// ⚠️ Anyone holding the token can do whatever that account can do. Give it an
// account with the least role that does the job, keep it in the host's
// environment settings and never in the repo, and change it to cut access off.
function configuredServiceToken(): string | null {
  const t = (process.env["SERVICE_API_TOKEN"] ?? "").trim();
  // A short secret is worse than none — refuse to honour it at all.
  return t.length >= 32 ? t : null;
}

function presentedServiceToken(req: Request): string | null {
  const header = req.headers["x-service-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const v = auth.slice(7).trim();
    if (v) return v;
  }
  return null;
}

/** Constant-time compare that does not leak the secret's length. */
function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function serviceTokenUser(req: Request): Promise<CurrentUser | null> {
  const configured = configuredServiceToken();
  if (!configured) return null;
  const presented = presentedServiceToken(req);
  if (!presented || !secretsMatch(presented, configured)) return null;

  const email = (process.env["SERVICE_API_USER_EMAIL"] ?? "").trim().toLowerCase();
  if (!email) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${email}`);
  if (!user || user.active === false) return null;
  return user;
}

export async function getOrProvisionCurrentUser(req: Request): Promise<CurrentUser | null> {
  // Checked FIRST so a token-bearing request never depends on a browser session.
  const viaToken = await serviceTokenUser(req);
  if (viaToken) return viaToken;

  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) return null;

  // Match by Clerk ID first. Re-apply the bootstrap allowlist even on an
  // existing row (before returning) so an allowlisted account always ends up
  // Admin regardless of provisioning order or boot timing.
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));
  if (existing) {
    if (!existing.active) return null;
    if (isBootstrapAdmin(existing.email) && existing.role !== "Admin") {
      const [promoted] = await db
        .update(usersTable)
        .set({ role: "Admin", active: true, updatedAt: new Date() })
        .where(eq(usersTable.id, existing.id))
        .returning();
      return promoted;
    }
    return existing;
  }

  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  // Emails are stored and compared lowercased so a case-variant from Clerk
  // (e.g. "Op2+..." vs "op2+...") links to the same account instead of
  // spawning a duplicate.
  const primaryEmail =
    (clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      null)?.toLowerCase() ?? null;
  const fullName =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() ||
    primaryEmail ||
    `User ${clerkUserId.slice(-6)}`;
  const initials = (
    ((clerkUser.firstName ?? "").charAt(0) + (clerkUser.lastName ?? "").charAt(0)) ||
    fullName.slice(0, 2)
  ).toUpperCase();

  const bootstrapAdmin = isBootstrapAdmin(primaryEmail);

  if (primaryEmail) {
    const [byEmail] = await db
      .select()
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${primaryEmail}`);
    if (byEmail) {
      if (!byEmail.active) return null;
      const [linked] = await db
        .update(usersTable)
        .set({
          clerkUserId,
          // Admin bootstrap is sticky and idempotent — re-applied on each link
          // so it survives manual role edits.
          ...(bootstrapAdmin ? { role: "Admin" } : {}),
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, byEmail.id))
        .returning();
      return linked;
    }
  }

  const [created] = await db
    .insert(usersTable)
    .values({
      clerkUserId,
      fullName,
      email: primaryEmail ?? `${clerkUserId}@unknown.local`,
      initials: await uniqueInitials(initials),
      role: bootstrapAdmin ? "Admin" : "Operator",
      active: true,
    })
    .returning();
  return created;
}

/**
 * Re-apply the bootstrap-admin allowlist for a user that's already in the DB
 * but might not have signed in since the env var was added. Called from a
 * one-shot at server boot. Safe to call repeatedly.
 */
export async function reconcileBootstrapAdmins(): Promise<void> {
  const emails = Array.from(getBootstrapAdminEmails());
  for (const email of emails) {
    await db
      .update(usersTable)
      .set({ role: "Admin", updatedAt: new Date() })
      .where(sql`lower(${usersTable.email}) = ${email} AND ${usersTable.active} = true`);
  }
}
