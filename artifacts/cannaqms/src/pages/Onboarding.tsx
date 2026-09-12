import { useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { onboardingPaths } from "@workspace/api-zod/onboarding-paths";
import type { OnboardingSnapshot } from "@workspace/api-zod/onboarding";
import { OnboardingController } from "@/components/setup/OnboardingController";
import { onboardingKey, useOnboarding } from "@/lib/onboarding";
import { BrandMark } from "@/components/BrandMark";
export default function Onboarding() {
  const { data, isError, refetch } = useOnboarding();
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { signOut } = useClerk();
  const finish = (snapshot: OnboardingSnapshot, destination: string) => {
    client.setQueryData(onboardingKey, snapshot);
    void client.invalidateQueries({ queryKey: ["me"] });
    navigate(destination);
  };
  if (!data)
    return (
      <main className="cq-loading">
        <BrandMark />
        <h1>{isError ? "Let's reconnect." : "Loading workspace setup."}</h1>
        <p role="status">
          {isError
            ? "Your setup couldn't be loaded. Please try again."
            : "Loading your saved place…"}
        </p>
        {isError && (
          <button className="cq-action" onClick={() => void refetch()}>
            Try again
          </button>
        )}
      </main>
    );
  return (
    <OnboardingController
      key={data.user.id}
      initial={data}
      onFinished={(next) =>
        finish(next, onboardingPaths[next.draft.focus].href)
      }
      onDeferred={(next) => finish(next, "/dashboard")}
      onExit={() => void signOut({ redirectUrl: "/" })}
    />
  );
}
