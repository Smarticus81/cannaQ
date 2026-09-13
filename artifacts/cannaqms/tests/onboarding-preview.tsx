// Separate Vite development entry. Production builds include index.html only.
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Router } from "wouter";
import { OnboardingController } from "../src/components/setup/OnboardingController";
import { OnboardingUnavailable } from "../src/components/setup/OnboardingUnavailable";
import { onboardingRequest } from "../src/lib/onboarding";
import type { OnboardingSnapshot } from "@workspace/api-zod";
import "../src/index.css";
import "../src/product.css";
const scenario = new URLSearchParams(window.location.search).get("scenario");
const apiBase =
  scenario && ["member", "returning", "pending"].includes(scenario)
    ? `/review-api/review/${scenario}/`
    : "/review-api/";
const reviewRequest: typeof onboardingRequest = (method, suffix, body) =>
  onboardingRequest(method, suffix, body, apiBase);
function Preview() {
  const [data, setData] = useState<OnboardingSnapshot>();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  const [retrying, setRetrying] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const reload = () => {
    setRetrying(true);
    void reviewRequest()
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch(setError)
      .finally(() => setRetrying(false));
  };
  useEffect(() => {
    void reviewRequest().then(setData).catch(setError);
  }, []);
  if (signedOut)
    return (
      <main className="cq-loading">
        <h1>Signed out of the review.</h1>
      </main>
    );
  if (error || scenario === "expired" || scenario === "inactive")
    return (
      <OnboardingUnavailable
        error={error ?? { status: scenario === "expired" ? 401 : 403 }}
        retrying={retrying}
        onRetry={reload}
        onSignOut={async () => {
          setSignedOut(true);
        }}
      />
    );
  if (!data) return <p>Loading isolated review database…</p>;
  if (done)
    return (
      <main className="cq-loading">
        <h1>Your workspace is ready.</h1>
        <p>Saved to the isolated review database.</p>
        <button className="cq-action" onClick={() => setDone(false)}>
          Review my introduction
        </button>
      </main>
    );
  return (
    <OnboardingController
      request={reviewRequest}
      initial={data}
      onFinished={(next) => {
        setData(next);
        setDone(true);
      }}
      onDeferred={(next) => {
        setData(next);
        setDone(true);
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(
  <Router>
    <Preview />
  </Router>,
);
