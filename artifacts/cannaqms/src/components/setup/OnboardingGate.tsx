import type { PropsWithChildren } from "react";
import { useAuth, useClerk } from "@clerk/react";
import { Redirect, useLocation } from "wouter";
import { useOnboarding, usePreferences } from "@/lib/onboarding";
import { isPublicRoute, onboardingDestination } from "@/lib/navigation";
import { OnboardingUnavailable } from "./OnboardingUnavailable";
export function OnboardingGate({ children }: PropsWithChildren) {
  const [location] = useLocation();
  const { isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const publicRoute = isPublicRoute(location);
  const introduction = location === "/onboarding";
  const { data, isError, error, isFetching, refetch } = useOnboarding(
    !!isSignedIn && !publicRoute,
  );
  usePreferences(introduction ? undefined : data?.draft);
  if (publicRoute || introduction || !isSignedIn) return children;
  if (isError)
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
      <div className="cq-loading" role="status">
        Finding your saved place…
      </div>
    );
  if (
    data.accessPending ||
    data.needsWorkspace ||
    (!data.completedAt && !data.deferredAt)
  )
    return (
      <Redirect
        to={onboardingDestination(
          location + window.location.search + window.location.hash,
        )}
      />
    );
  return children;
}
