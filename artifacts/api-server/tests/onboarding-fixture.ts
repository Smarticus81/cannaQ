import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  companyProfileTable,
  facilitiesTable,
  userFacilitiesTable,
  auditLogTable,
} from "@workspace/db/schema";
import type { AppDatabase } from "@workspace/db";
import {
  createOnboardingService,
  type OnboardingActor,
} from "../src/services/onboarding";
import { ONBOARDING_SCHEMA_SQL } from "../src/lib/onboardingSchema";

// A real, isolated Postgres engine. Only related tables are installed; their
// columns come from the production Drizzle definitions. No external credentials.
export async function onboardingFixture() {
  const pg = new PGlite();
  await pg.exec(
    "CREATE TABLE users (id serial PRIMARY KEY, active_facility_id integer, updated_at timestamptz DEFAULT now()); INSERT INTO users(id) VALUES(1),(2),(3),(4);",
  );
  for (const table of [
    companyProfileTable,
    facilitiesTable,
    userFacilitiesTable,
    auditLogTable,
  ]) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      const type = column.getSQLType();
      const extra =
        column.name === "id"
          ? " PRIMARY KEY"
          : type.includes("timestamp")
            ? " DEFAULT now()"
            : type === "boolean"
              ? " DEFAULT true"
              : "";
      return `"${column.name}" ${type}${extra}`;
    });
    await pg.exec(`CREATE TABLE "${config.name}" (${columns.join(",")});`);
  }
  await pg.exec(
    "CREATE UNIQUE INDEX fixture_membership ON user_facilities(user_id,facility_id);",
  );
  await pg.exec(ONBOARDING_SCHEMA_SQL);
  const database = drizzle(pg) as unknown as AppDatabase;
  const actors: Record<string, OnboardingActor> = {
    admin: {
      id: 1,
      fullName: "Alex Morgan",
      initials: "AM",
      role: "Admin",
      activeFacilityId: null,
      active: true,
    },
    member: {
      id: 2,
      fullName: "Taylor Ellis",
      initials: "TE",
      role: "Operator",
      activeFacilityId: null,
      active: true,
    },
    colleague: {
      id: 3,
      fullName: "Robin Avery",
      initials: "RA",
      role: "Admin",
      activeFacilityId: null,
      active: true,
    },
    inactive: {
      id: 4,
      fullName: "Inactive Account",
      initials: "IA",
      role: "Operator",
      activeFacilityId: null,
      active: false,
    },
  };
  return { pg, database, actors, service: createOnboardingService(database) };
}
