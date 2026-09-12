import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import { onboardingPaths } from "@workspace/api-zod/onboarding-paths";
import { useOnboarding } from "@/lib/onboarding";
export function SetupChecklist() {
  const { data } = useOnboarding();
  if (!data) return null;
  const path = onboardingPaths[data.draft.focus];
  return (
    <section className="cq-orientation" aria-label="Your next step">
      <span className="cq-eyebrow">
        {data.completedAt ? "WORKFLOW SHORTCUT" : "INCOMPLETE WORKSPACE SETUP"}
      </span>
      <div>
        <h2>
          {data.completedAt ? path.title : "Finish your workspace setup."}
        </h2>
        <p>
          {data.completedAt
            ? path.description
            : `Your setup is saved at step ${data.draft.step + 1} of 6. Resume to confirm your remaining details.`}
        </p>
      </div>
      <Link href={data.completedAt ? path.href : "/onboarding"}>
        {data.completedAt ? "Explore" : "Resume setup"}
        <ArrowUpRight size={19} />
      </Link>
    </section>
  );
}
