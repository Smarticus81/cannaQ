import { useState } from "react";
import { BrandMark } from "../BrandMark";
import { onboardingAccessStatus } from "../../lib/onboarding-errors";

export function OnboardingUnavailable({
  error,
  retrying,
  onRetry,
  onSignOut,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  onSignOut: () => Promise<unknown>;
}) {
  const access = onboardingAccessStatus(error);
  const [leaving, setLeaving] = useState(false);
  const [exitError, setExitError] = useState("");
  async function leave() {
    setLeaving(true);
    setExitError("");
    try {
      await onSignOut();
    } catch {
      setExitError("We couldn't sign you out. Please try again.");
    } finally {
      setLeaving(false);
    }
  }
  return (
    <main className="cq-loading cq-recovery">
      <BrandMark />
      <h1>
        {access === 403
          ? "Your account needs access."
          : access === 401
            ? "Sign in to continue."
            : "Let's reconnect."}
      </h1>
      <p role="status">
        {access === 403
          ? "Your account is inactive. Contact your administrator to restore access, or sign in with another account. Your saved setup stays with your account."
          : access === 401
            ? "Your session has expired or couldn't be verified. Sign in again to return to your saved setup."
            : "We couldn't load your workspace. Your saved setup is still there; try again when your connection is ready."}
      </p>
      <div className="cq-recovery-actions">
        {access !== 401 && (
          <button
            className="cq-action"
            disabled={retrying || leaving}
            onClick={onRetry}
          >
            {retrying
              ? "Checking access…"
              : access === 403
                ? "Check access again"
                : "Try again"}
          </button>
        )}
        <button
          className={access === 401 ? "cq-action" : "cq-text-action"}
          disabled={leaving || retrying}
          onClick={() => void leave()}
        >
          {leaving
            ? "Signing out…"
            : access === 401
              ? "Sign in again"
              : "Sign out"}
        </button>
      </div>
      {exitError && <p role="alert">{exitError}</p>}
    </main>
  );
}
