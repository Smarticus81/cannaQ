import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@workspace/db";
import {
  userOnboardingTable,
  companyProfileTable,
  facilitiesTable,
  userFacilitiesTable,
  usersTable,
  auditLogTable,
} from "@workspace/db/schema";
import {
  onboardingDraftSchema,
  type OnboardingDraft,
  type OnboardingSnapshot,
} from "@workspace/api-zod";

export type OnboardingActor = {
  id: number;
  fullName: string;
  initials: string;
  role: string;
  activeFacilityId: number | null;
  active: boolean;
};
export class OnboardingError extends Error {
  constructor(
    public status: number,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

const facilityColumns = {
  id: facilitiesTable.id,
  name: facilitiesTable.name,
  licenseNumber: facilitiesTable.licenseNumber,
  state: facilitiesTable.state,
  timeZone: facilitiesTable.timeZone,
};

export function createOnboardingService(database: AppDatabase) {
  async function context(
    actor: OnboardingActor,
    selectedId: number | null = null,
    conn = database,
  ) {
    const facilities =
      actor.role === "Admin"
        ? await conn
            .select(facilityColumns)
            .from(facilitiesTable)
            .where(eq(facilitiesTable.isActive, true))
            .orderBy(asc(facilitiesTable.id))
        : await conn
            .select(facilityColumns)
            .from(facilitiesTable)
            .innerJoin(
              userFacilitiesTable,
              eq(userFacilitiesTable.facilityId, facilitiesTable.id),
            )
            .where(
              and(
                eq(userFacilitiesTable.userId, actor.id),
                eq(facilitiesTable.isActive, true),
              ),
            )
            .orderBy(asc(facilitiesTable.id));
    const facility =
      facilities.find((f) => f.id === (selectedId ?? actor.activeFacilityId)) ??
      facilities[0] ??
      null;
    const [company] =
      actor.role === "Admin" || facilities.length
        ? await conn
            .select({
              id: companyProfileTable.id,
              companyName: companyProfileTable.companyName,
            })
            .from(companyProfileTable)
            .limit(1)
        : [];
    const companyName =
      company?.companyName === "My Company" ? "" : (company?.companyName ?? "");
    return {
      facilities,
      facility,
      companyName,
      companyId: company?.id,
      needsWorkspace:
        actor.role === "Admin" &&
        (!companyName || !facility?.licenseNumber?.trim()),
      accessPending: actor.role !== "Admin" && facilities.length === 0,
    };
  }

  async function get(actor: OnboardingActor): Promise<OnboardingSnapshot> {
    if (!actor.active)
      throw new OnboardingError(
        403,
        "This account is inactive. Please contact your administrator.",
      );
    const initial = await context(actor);
    const defaultDraft = onboardingDraftSchema.parse({
      focus:
        actor.role === "Quality"
          ? "quality"
          : ["Operator", "Supervisor"].includes(actor.role)
            ? "production"
            : "operations",
      companyName: initial.companyName,
      facilityName:
        initial.facility?.name === "Main Facility"
          ? ""
          : (initial.facility?.name ?? ""),
      licenseNumber: initial.facility?.licenseNumber ?? "",
      state: initial.facility?.state ?? "MI",
      timeZone: initial.facility?.timeZone ?? "America/Detroit",
      facilityId: initial.facility?.id ?? null,
    });
    await database
      .insert(userOnboardingTable)
      .values({ userId: actor.id, draft: defaultDraft })
      .onConflictDoNothing();
    const [row] = await database
      .select()
      .from(userOnboardingTable)
      .where(eq(userOnboardingTable.userId, actor.id));
    if (!row)
      throw new OnboardingError(
        503,
        "We couldn't load your saved place. Please try again.",
      );
    const draft = onboardingDraftSchema.parse(row.draft);
    const { companyId: _companyId, ...workspace } = await context(
      actor,
      draft.facilityId,
    );
    return {
      ...workspace,
      revision: row.revision,
      draft,
      completedAt: row.completedAt?.toISOString() ?? null,
      deferredAt: row.deferredAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      user: {
        id: actor.id,
        fullName: actor.fullName,
        initials: actor.initials,
        role: actor.role,
      },
    };
  }

  async function save(
    actor: OnboardingActor,
    revision: number,
    draft: OnboardingDraft,
  ) {
    if (!actor.active)
      throw new OnboardingError(403, "This account is inactive.");
    const [updated] = await database
      .update(userOnboardingTable)
      .set({ draft, revision: revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(userOnboardingTable.userId, actor.id),
          eq(userOnboardingTable.revision, revision),
        ),
      )
      .returning();
    if (!updated)
      throw new OnboardingError(
        409,
        "Your progress changed in another tab. Load that saved version before continuing.",
      );
    return get(actor);
  }

  async function defer(actor: OnboardingActor, revision: number) {
    if (!actor.active)
      throw new OnboardingError(403, "This account is inactive.");
    const [updated] = await database
      .update(userOnboardingTable)
      .set({
        deferredAt: new Date(),
        revision: revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userOnboardingTable.userId, actor.id),
          eq(userOnboardingTable.revision, revision),
        ),
      )
      .returning();
    if (!updated)
      throw new OnboardingError(
        409,
        "Your progress changed in another tab. Load the saved version to continue.",
      );
    return get(actor);
  }

  async function complete(
    actor: OnboardingActor,
    revision: number,
  ): Promise<OnboardingSnapshot> {
    if (!actor.active)
      throw new OnboardingError(403, "This account is inactive.");
    await database.transaction(async (tx) => {
      // Serializes first-workspace setup across administrators, as well as a
      // double-click from one account. No remote service calls occur in this transaction.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(841903)`);
      const [row] = await tx
        .select()
        .from(userOnboardingTable)
        .where(eq(userOnboardingTable.userId, actor.id))
        .for("update");
      if (!row)
        throw new OnboardingError(
          409,
          "Save your introduction before finishing.",
        );
      if (
        row.completedAt &&
        row.completedRevision === revision + 1 &&
        row.revision === row.completedRevision
      )
        return;
      if (row.revision !== revision)
        throw new OnboardingError(
          409,
          "Your progress changed in another tab. Load the saved version to continue.",
        );
      const draft = onboardingDraftSchema.parse(row.draft);
      if (!draft.identityConfirmed)
        throw new OnboardingError(
          422,
          "Please confirm your name and initials before continuing.",
          "identityConfirmed",
        );
      const current = await context(
        actor,
        draft.facilityId,
        tx as unknown as AppDatabase,
      );
      if (current.accessPending)
        throw new OnboardingError(
          403,
          "Your administrator needs to assign you to a facility. Your progress is saved.",
        );
      if (
        draft.facilityId !== null &&
        !current.facilities.some((f) => f.id === draft.facilityId)
      ) {
        throw new OnboardingError(
          403,
          "That facility is no longer available to your account.",
          "facilityId",
        );
      }
      let facilityId = current.facility?.id;
      if (current.needsWorkspace) {
        for (const field of [
          "companyName",
          "facilityName",
          "licenseNumber",
        ] as const) {
          if (!draft[field].trim())
            throw new OnboardingError(
              422,
              "Add this detail so your workspace has a clear identity.",
              field,
            );
        }
        if (!/^[A-Z]{2}$/.test(draft.state))
          throw new OnboardingError(
            422,
            "Choose a two-letter state code.",
            "state",
          );
        try {
          new Intl.DateTimeFormat("en-US", {
            timeZone: draft.timeZone,
          }).format();
        } catch {
          throw new OnboardingError(
            422,
            "Choose a valid time zone.",
            "timeZone",
          );
        }
        if (!current.companyName) {
          if (current.companyId)
            await tx
              .update(companyProfileTable)
              .set({ companyName: draft.companyName, updatedAt: new Date() })
              .where(eq(companyProfileTable.id, current.companyId));
          else
            await tx
              .insert(companyProfileTable)
              .values({ companyName: draft.companyName });
        }
        // Only fill an unconfigured site. This introduction never overwrites a
        // configured licence or company, including changes made in another tab.
        if (!current.facility?.licenseNumber?.trim()) {
          const values = {
            name: draft.facilityName,
            licenseNumber: draft.licenseNumber,
            state: draft.state,
            timeZone: draft.timeZone,
          };
          if (facilityId)
            await tx
              .update(facilitiesTable)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(facilitiesTable.id, facilityId));
          else {
            const [created] = await tx
              .insert(facilitiesTable)
              .values(values)
              .returning({ id: facilitiesTable.id });
            facilityId = created.id;
          }
        }
      }
      if (!facilityId)
        throw new OnboardingError(
          422,
          "A facility is needed before you can enter your workspace.",
        );
      if (actor.role === "Admin") {
        await tx
          .insert(userFacilitiesTable)
          .values({ userId: actor.id, facilityId })
          .onConflictDoNothing();
      }
      await tx
        .update(usersTable)
        .set({ activeFacilityId: facilityId, updatedAt: new Date() })
        .where(eq(usersTable.id, actor.id));
      await tx
        .update(userOnboardingTable)
        .set({
          draft: { ...draft, step: 5, facilityId },
          revision: row.revision + 1,
          completedRevision: row.revision + 1,
          completedAt: new Date(),
          deferredAt: null,
          updatedAt: new Date(),
        })
        .where(eq(userOnboardingTable.userId, actor.id));
      await tx
        .insert(auditLogTable)
        .values({
          tableName: "user_onboarding",
          rowId: actor.id,
          operation: "ONBOARDING_COMPLETED",
          changedBy: actor.id,
          changedByName: actor.fullName,
          afterState: {
            facilityId,
            focus: draft.focus,
            workspaceConfigured: current.needsWorkspace,
          },
        });
    });
    return get(actor);
  }

  return { get, save, defer, complete };
}
