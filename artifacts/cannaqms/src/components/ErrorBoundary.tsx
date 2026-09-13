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
              This work area could not open. Try reloading it, or return to your
              dashboard and continue with another work area.
            </p>
            {isDev && (
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" asChild>
                <a href={`${import.meta.env.BASE_URL}dashboard`}>Back to dashboard</a>
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
