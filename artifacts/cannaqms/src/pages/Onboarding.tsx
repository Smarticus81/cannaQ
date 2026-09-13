import { useClerk } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { facilityDestination, workspaceReturnTo } from "@/lib/navigation";
import { useLocation } from "wouter";
import { onboardingPaths } from "@workspace/api-zod/onboarding-paths";
import type { OnboardingSnapshot } from "@workspace/api-zod/onboarding";
import { OnboardingController } from "@/components/setup/OnboardingController";
import { onboardingKey, useOnboarding } from "@/lib/onboarding";
import { BrandMark } from "@/components/BrandMark";
import { OnboardingUnavailable } from "@/components/setup/OnboardingUnavailable";
import { onboardingAccessStatus } from "@/lib/onboarding-errors";
export default function Onboarding() {
  const { data, isError, error, isFetching, refetch } = useOnboarding();
  const client = useQueryClient();
  const [, navigate] = useLocation();
  const { signOut } = useClerk();
  const finish = (snapshot: OnboardingSnapshot, destination: string) => {
    const facilityChanged = snapshot.facility?.id !== data?.facility?.id;
    if (facilityChanged) client.clear();
    client.setQueryData(onboardingKey, snapshot);
    void client.invalidateQueries({ queryKey: ["me"] });
    const returnTo = workspaceReturnTo(
      new URLSearchParams(window.location.search).get("returnTo"),
    );
    const target = returnTo ?? destination;
    navigate(facilityChanged ? facilityDestination(target) : target, {
      replace: true,
    });
  };
  if (isError && (!data || onboardingAccessStatus(error)))
    return (
      <OnboardingUnavailable
        error={error}
        retrying={isFetching}
        onRetry={() => void refetch()}
        onSignOut={() => signOut({ redirectUrl: "/sign-in" })}
      />
    );
  if (!data)
    return (
      <main className="cq-loading">
        <BrandMark />
        <h1>Loading workspace setup.</h1>
        <p role="status">Loading your saved place…</p>
      </main>
    );
  return (
    <OnboardingController
      returnToRequestedPage={
        !!workspaceReturnTo(
          new URLSearchParams(window.location.search).get("returnTo"),
        )
      }
      key={data.user.id}
      initial={data}
      onFinished={(next) =>
        finish(next, onboardingPaths[next.draft.focus].href)
      }
      onDeferred={(next) => finish(next, "/dashboard")}
      onExit={() => signOut({ redirectUrl: import.meta.env.BASE_URL })}
    />
  );
}
