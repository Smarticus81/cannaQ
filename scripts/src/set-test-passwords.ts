import { createClerkClient } from "@clerk/backend";

const SECRET = process.env.CLERK_SECRET_KEY;
if (!SECRET) { console.error("CLERK_SECRET_KEY not set"); process.exit(1); }
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1") {
  console.error("✗ REFUSED: set-test-passwords cannot run in production. This script seeds known sandbox credentials only.");
  process.exit(2);
}
if (SECRET.startsWith("sk_live_")) {
  console.error("✗ REFUSED: CLERK_SECRET_KEY is a LIVE key (sk_live_…). Refusing to set predictable test password against a live Clerk instance.");
  process.exit(2);
}

const TARGETS: Array<{ email: string; firstName: string; lastName: string }> = [
  { email: "operator@test.com",   firstName: "Test", lastName: "Operator" },
  { email: "manager@test.com",    firstName: "Test", lastName: "Manager" },
  { email: "supervisor@test.com", firstName: "Test", lastName: "Supervisor" },
  { email: "quality@test.com",    firstName: "Test", lastName: "Quality" },
];
const NEW_PASSWORD = "Test123!";

async function run() {
  const clerk = createClerkClient({ secretKey: SECRET });
  console.log(`\n🔑 Ensuring ${TARGETS.length} test accounts exist with password "${NEW_PASSWORD}"…\n`);
  let updated = 0, created = 0, failed = 0;
  for (const t of TARGETS) {
    try {
      const list = await clerk.users.getUserList({ emailAddress: [t.email] });
      let user = list.data[0];
      if (!user) {
        user = await clerk.users.createUser({
          emailAddress: [t.email],
          password: NEW_PASSWORD,
          firstName: t.firstName,
          lastName: t.lastName,
          skipPasswordChecks: true,
          skipPasswordRequirement: false,
        });
        console.log(`  + CREATE ${t.email} (${user.id})`);
        created++;
      } else {
        await clerk.users.updateUser(user.id, { password: NEW_PASSWORD, signOutOfOtherSessions: true, skipPasswordChecks: true });
        console.log(`  ✓ UPDATE ${t.email} (${user.id})`);
        updated++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${t.email} — ${msg}`);
      failed++;
    }
  }
  console.log(`\n→ ${created} created, ${updated} updated, ${failed} failed.`);
  console.log(`\nNOTE: Roles default to Operator. After first sign-in, an Admin must promote them via /users (PATCH role) or set BOOTSTRAP_ADMIN_EMAILS for any admin accounts.\n`);
}

run().catch((e) => { console.error(e); process.exit(1); });
