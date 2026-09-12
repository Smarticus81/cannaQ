import type { PropsWithChildren } from "react";
import { useAuth } from "@clerk/react";
import { Redirect, useLocation } from "wouter";
import { useOnboarding, usePreferences } from "@/lib/onboarding";
export function OnboardingGate({ children }: PropsWithChildren) {
  const [location] = useLocation();
  const { isSignedIn } = useAuth();
  const publicRoute = location === "/" || location.startsWith("/sign-");
  const introduction = location === "/onboarding";
  const { data, isError, refetch } = useOnboarding(
    !!isSignedIn && !publicRoute,
  );
  usePreferences(introduction ? undefined : data?.draft);
  if (publicRoute || introduction || !isSignedIn) return children;
  if (isError)
    return (
      <main className="cq-loading">
        <h1>Let's reconnect.</h1>
        <p>We couldn't check your workspace access.</p>
        <button className="cq-action" onClick={() => void refetch()}>
          Try again
        </button>
      </main>
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
    return <Redirect to="/onboarding" />;
  return children;
}
