// First-run setup checklist (Session 71, PR 2).
//
// A dismissible "Get started" card on the Dashboard. It calls GET /setup-status
// (off-spec, so raw fetch like NotificationBell) and renders the first-run
// milestones with done / not-done state, linking the operator to each step.
// It hides itself once every step is complete, and an operator can dismiss it
// early (remembered in localStorage). This is the visible half of the
// "a stranger can deploy and use it" milestone.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, Circle, ArrowRight, Rocket, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL ?? "/";
const DISMISS_KEY = "cannaq.setupChecklist.dismissed";

type SetupStatus = {
  companyProfile: boolean;
  teamMembers: boolean;
  firstSupplier: boolean;
  approvedTestingLab: boolean;
  firstBatch: boolean;
  completed: number;
  total: number;
  allComplete: boolean;
};

// Step copy + destinations live on the client; the server only reports the
// booleans. `key` matches a SetupStatus flag.
type StepMeta = { key: keyof SetupStatus; label: string; description: string; route: string; cta: string };

const STEPS: StepMeta[] = [
  {
    key: "companyProfile",
    label: "Set up your company profile",
    description: "Add your facility name and Michigan license number so records reference the right entity.",
    route: "/settings",
    cta: "Open Settings",
  },
  {
    key: "teamMembers",
    label: "Add your team",
    description: "Invite the people who'll sign records. Roles control who can approve and e-sign under Part 11.",
    route: "/settings",
    cta: "Manage users",
  },
  {
    key: "firstSupplier",
    label: "Add your first supplier",
    description: "Your approved vendors for cannabis material, packaging, and services — the source of every COA.",
    route: "/suppliers",
    cta: "Add a supplier",
  },
  {
    key: "approvedTestingLab",
    label: "Qualify an approved testing lab",
    description: "Add a supplier of type “Testing Laboratory” and approve it, so batches can carry test results.",
    route: "/suppliers",
    cta: "Add a lab",
  },
  {
    key: "firstBatch",
    label: "Create your first batch",
    description: "Start a production record from a recipe — ingredients, testing, labeling, and release.",
    route: "/batches",
    cta: "Create a batch",
  },
];

export function SetupChecklist() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try { setDismissed(localStorage.getItem(DISMISS_KEY) === "1"); } catch { /* ignore */ }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BASE}api/setup-status`, { credentials: "include" });
        if (r.ok && !cancelled) setStatus((await r.json()) as SetupStatus);
      } catch {
        // Silent — if setup-status can't load, just don't show the card.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
  }

  // Don't render until we know the state; hide when complete or dismissed.
  if (!loaded || !status || status.allComplete || dismissed) return null;

  return (
    <Card className="border-primary/30 bg-primary/[0.03]" data-testid="card-setup-checklist">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-primary/10 p-1.5">
            <Rocket className="h-4 w-4 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Get started with CannaQ</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status.completed} of {status.total} steps complete — finish setup to get your facility running.
            </p>
          </div>
        </div>
        <button
          onClick={dismiss}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss setup checklist"
          data-testid="button-dismiss-setup"
        >
          <X className="h-4 w-4" />
        </button>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Progress bar */}
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${status.total > 0 ? (status.completed / status.total) * 100 : 0}%` }}
          />
        </div>

        <ul className="space-y-1">
          {STEPS.map((step) => {
            const done = Boolean(status[step.key]);
            return (
              <li
                key={step.key}
                className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50 transition-colors"
                data-testid={`setup-step-${step.key}`}
              >
                {done ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                ) : (
                  <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground/40" />
                )}
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium ${done ? "text-muted-foreground line-through" : "text-foreground"}`}>
                    {step.label}
                  </p>
                  {!done && (
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{step.description}</p>
                  )}
                </div>
                {!done && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setLocation(step.route)}
                    data-testid={`button-setup-${step.key}`}
                  >
                    {step.cta}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
