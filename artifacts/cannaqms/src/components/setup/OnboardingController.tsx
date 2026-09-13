import { useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingDraft, OnboardingSnapshot } from "@workspace/api-zod";
import { OnboardingExperience } from "./OnboardingExperience";
import {
  onboardingRequest,
  OnboardingRequestError,
  usePreferences,
} from "@/lib/onboarding";
type Props = {
  returnToRequestedPage?: boolean;
  request?: typeof onboardingRequest;
  initial: OnboardingSnapshot;
  onFinished: (snapshot: OnboardingSnapshot) => void;
  onDeferred: (snapshot: OnboardingSnapshot) => void;
  onExit?: () => void | Promise<void>;
};

// Serialize writes and flush edits entered while an earlier save was in flight.
export function OnboardingController({
  returnToRequestedPage,
  initial,
  onFinished,
  onDeferred,
  onExit,
  request = onboardingRequest,
}: Props) {
  const [snapshot, setSnapshot] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const latest = useRef(initial.draft);
  const saved = useRef(JSON.stringify(initial.draft));
  const revision = useRef(initial.revision);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const conflict = useRef(false);
  const [status, setStatus] = useState<
    "saved" | "saving" | "unsaved" | "error"
  >("saved");
  const [error, setError] = useState<{
    message: string;
    field?: string;
    conflict?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  usePreferences(draft);
  const report = useCallback((cause: unknown) => {
    const failure =
      cause instanceof OnboardingRequestError
        ? cause
        : new OnboardingRequestError(
            "We couldn't reach your workspace. Your edits are still here; please try again.",
            503,
          );
    conflict.current = failure.status === 409;
    setError({
      message: failure.message,
      field: failure.field?.replace(/^draft\./, ""),
      conflict: conflict.current,
    });
    setStatus("error");
  }, []);
  const accept = (next: OnboardingSnapshot) => {
    revision.current = next.revision;
    setSnapshot(next);
  };
  const save = useCallback(() => {
    const task = queue.current
      .catch(() => {})
      .then(async () => {
        if (conflict.current)
          throw new OnboardingRequestError(
            "Load your saved progress before continuing.",
            409,
          );
        while (JSON.stringify(latest.current) !== saved.current) {
          setStatus("saving");
          const captured = latest.current;
          const next = await request("PATCH", "", {
            revision: revision.current,
            draft: captured,
          });
          accept(next);
          saved.current = JSON.stringify(captured);
        }
        setStatus("saved");
        setError(null);
      });
    queue.current = task;
    return task;
  }, [request]);
  function change(partial: Partial<OnboardingDraft>) {
    latest.current = { ...latest.current, ...partial };
    setDraft(latest.current);
    setStatus("unsaved");
  }
  useEffect(() => {
    if (JSON.stringify(draft) === saved.current || conflict.current) return;
    const timer = window.setTimeout(() => {
      void save().catch(report);
    }, 700);
    return () => clearTimeout(timer);
  }, [draft, save, report]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(latest.current) !== saved.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  async function action(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await run();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    await action(async () => {
      await queue.current.catch(() => {});
      if (!conflict.current) await save();
      const next = await request();
      accept(next);
      latest.current = next.draft;
      saved.current = JSON.stringify(next.draft);
      setDraft(next.draft);
      conflict.current = false;
      setError(null);
      setStatus("saved");
    });
  }
  return (
    <OnboardingExperience
      returnToRequestedPage={returnToRequestedPage}
      snapshot={snapshot}
      draft={draft}
      saveStatus={status}
      error={error}
      busy={busy}
      paused={paused}
      onChange={change}
      onExit={
        onExit
          ? () =>
              void action(async () => {
                await save();
                try {
                  await onExit();
                } catch {
                  throw new OnboardingRequestError(
                    "Could not sign out. Your session is still open; check your connection and try again.",
                    503,
                  );
                }
              })
          : undefined
      }
      onResume={() => setPaused(false)}
      onRetry={() => void action(save)}
      onReload={() => void reload()}
      onNavigate={(step) =>
        action(async () => {
          await save();
          change({ step });
          await save();
        })
      }
      onComplete={() =>
        action(async () => {
          await save();
          const next = await request("POST", "/complete", {
            revision: revision.current,
          });
          accept(next);
          onFinished(next);
        })
      }
      onDefer={() =>
        action(async () => {
          await save();
          const next = await request("POST", "/defer", {
            revision: revision.current,
          });
          accept(next);
          if (next.accessPending || next.needsWorkspace) setPaused(true);
          else onDeferred(next);
        })
      }
    />
  );
}
