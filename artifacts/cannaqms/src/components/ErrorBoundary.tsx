// Session 42 (25 May feedback fix): top-level ErrorBoundary.
//
// Symptom this fixes: "Recipes tab → blank screen" and "+ New Batch → blank
// screen" from the 25 May walkthrough. Root cause: when the API returned an
// HTML error (e.g. a 5xx from a route querying a non-existent table on the
// freshly-deployed Railway Postgres), client code that does
// `(await fetch(...)).json()` threw a SyntaxError. With no boundary above the
// route, React unmounted the entire tree, leaving only the empty <div id="root"/>.
// Refresh recovered because the next mount started clean.
//
// This boundary catches render/effect errors below it and shows a recoverable
// fallback instead of blanking. The class component pattern is required —
// only class components can implement componentDidCatch / getDerivedStateFromError.
//
// Placement (see App.tsx): wraps <Switch> inside the QueryClientProvider so the
// boundary's fallback can still reach the providers (e.g. for theming via
// TooltipProvider's class scope). Wrapping individual routes would also work
// and would let the rest of the app stay mounted, but wrapping the Switch is
// the smallest blast-radius change for now. We can move to per-route boundaries
// later if we want to keep the sidebar reachable when a single page crashes.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface in DevTools console so we can debug what blew up. The original
    // 25 May "blank screen" was invisible without DevTools open precisely
    // because the tree unmounted silently; logging here means future crashes
    // are always findable in the Console tab.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught render error:", error, info.componentStack);
  }

  handleReload = () => {
    // Full reload re-runs the auth + clerk + query-client init from scratch,
    // matching the "refresh fixes it" behavior Jonathan saw in the 25 May walkthrough.
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      const isDev = import.meta.env.DEV;
      return (
        <div className="flex min-h-[60vh] items-center justify-center px-4">
          <div className="max-w-md w-full rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mt-1">
              This page hit an unexpected error. Reloading usually clears it. If it
              keeps happening, the API may be returning a non-JSON response — open
              DevTools → Network and check the failing request.
            </p>
            {isDev && (
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => this.setState({ error: null })}>
                Dismiss
              </Button>
              <Button onClick={this.handleReload}>Reload</Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
