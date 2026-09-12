import { z } from "zod";

export const onboardingDraftSchema = z
  .object({
    step: z.number().int().min(0).max(5).default(0),
    identityConfirmed: z.boolean().default(false),
    experience: z.enum(["new", "familiar"]).default("new"),
    focus: z.enum(["quality", "production", "operations"]).default("quality"),
    theme: z.enum(["light", "dark", "system"]).default("light"),
    workspaceMode: z.enum(["guided", "focused"]).default("guided"),
    density: z.enum(["comfortable", "compact"]).default("comfortable"),
    companyName: z.string().trim().max(160).default(""),
    facilityName: z.string().trim().max(160).default(""),
    licenseNumber: z.string().trim().max(100).default(""),
    state: z.string().trim().max(2).default("MI"),
    timeZone: z.string().trim().max(100).default("America/Detroit"),
    facilityId: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const onboardingSaveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    draft: onboardingDraftSchema,
  })
  .strict();

export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;
export type OnboardingFacility = {
  id: number;
  name: string;
  licenseNumber: string | null;
  state: string;
  timeZone: string | null;
};
export type OnboardingSnapshot = {
  revision: number;
  draft: OnboardingDraft;
  completedAt: string | null;
  deferredAt: string | null;
  updatedAt: string;
  user: { id: number; fullName: string; initials: string; role: string };
  companyName: string;
  facilities: OnboardingFacility[];
  facility: OnboardingFacility | null;
  needsWorkspace: boolean;
  accessPending: boolean;
};

export { onboardingPaths } from "./onboarding-paths";
