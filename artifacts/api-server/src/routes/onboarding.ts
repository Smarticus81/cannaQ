import { Router, type Request } from "express";
import { z } from "zod";
import { onboardingSaveSchema } from "@workspace/api-zod";
import {
  OnboardingError,
  type OnboardingActor,
  type createOnboardingService,
} from "../services/onboarding";

type Service = ReturnType<typeof createOnboardingService>;
type ActorResolver = (req: Request) => Promise<OnboardingActor | null>;
const revisionSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();

/** Mounted before facility scoping: an unassigned person can only access their
 * own introduction. The service explicitly checks every workspace membership. */
export function createOnboardingRouter(
  service: Service,
  resolveActor: ActorResolver,
) {
  const router = Router();
  for (const [method, path, operation] of [
    ["get", "/onboarding", "get"],
    ["patch", "/onboarding", "save"],
    ["post", "/onboarding/defer", "defer"],
    ["post", "/onboarding/complete", "complete"],
  ] as const) {
    router[method](path, async (req, res) => {
      try {
        const actor = await resolveActor(req);
        if (!actor || !actor.active) {
          res.status(401).json({ error: "Please sign in to continue." });
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        if (operation === "get") {
          res.json(await service.get(actor));
          return;
        }
        if (operation === "save") {
          const { revision, draft } = onboardingSaveSchema.parse(req.body);
          res.json(await service.save(actor, revision, draft));
          return;
        }
        const { revision } = revisionSchema.parse(req.body);
        res.json(await service[operation](actor, revision));
      } catch (error) {
        if (error instanceof z.ZodError) {
          res
            .status(422)
            .json({
              error: "Please check the highlighted details.",
              field: error.issues[0]?.path.join("."),
              details: error.issues.map((i) => ({
                field: i.path.join("."),
                message: i.message,
              })),
            });
          return;
        }
        if (error instanceof OnboardingError) {
          res
            .status(error.status)
            .json({ error: error.message, field: error.field });
          return;
        }
        req.log?.error({ err: error }, "Onboarding request failed");
        res
          .status(503)
          .json({
            error:
              "We couldn't save your place just now. Your changes are still here; please try again.",
          });
      }
    });
  }
  return router;
}
