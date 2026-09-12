import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "wouter";
import { Bell, AlertCircle, AlertTriangle, ShieldAlert, MessageSquareWarning, Factory, X, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NotificationLevel = "critical" | "warning" | "info";
type NotificationCategory = "nc" | "complaint" | "field_action" | "batch" | "capa";

type Notification = {
  id: string;
  level: NotificationLevel;
  category: NotificationCategory;
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
};

type NotificationsResponse = {
  notifications: Notification[];
  totalCount: number;
  criticalCount: number;
};

const BASE = import.meta.env.BASE_URL ?? "/";
const POLL_INTERVAL = 60_000; // 60 s

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function categoryIcon(category: NotificationCategory, level: NotificationLevel) {
  const cls = cn(
    "h-4 w-4 shrink-0 mt-0.5",
    level === "critical" ? "text-red-500" : "text-amber-500"
  );
  if (category === "nc") return <AlertTriangle className={cls} />;
  if (category === "field_action") return <ShieldAlert className={cls} />;
  if (category === "complaint") return <MessageSquareWarning className={cls} />;
  if (category === "batch") return <Factory className={cls} />;
  if (category === "capa") return <ClipboardList className={cls} />;
  return <AlertCircle className={cls} />;
}

function categoryLabel(category: NotificationCategory): string {
  if (category === "nc") return "Non-Conformance";
  if (category === "field_action") return "Field Action";
  if (category === "complaint") return "Complaint";
  if (category === "batch") return "Batch Record";
  if (category === "capa") return "CAPA";
  return "Alert";
}

export function NotificationBell() {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}api/notifications`, { credentials: "include" });
      if (r.ok) setData(await r.json() as NotificationsResponse);
    } catch {
      // silent fail — bell just shows no badge
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    void fetchNotifications();
    const timer = setInterval(() => void fetchNotifications(), POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const total = data?.totalCount ?? 0;
  const critical = data?.criticalCount ?? 0;
  const notifications = data?.notifications ?? [];

  // Group by category for header counts
  const groups = {
    critical: notifications.filter((n) => n.level === "critical"),
    warning: notifications.filter((n) => n.level === "warning"),
  };

  return (
    <div className="relative">
      <Button
        ref={btnRef}
        variant="ghost"
        size="icon"
        className="relative h-9 w-9"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${total > 0 ? ` (${total})` : ""}`}
      >
        <Bell className="h-5 w-5" />
        {total > 0 && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white leading-none",
              critical > 0 ? "bg-red-600" : "bg-amber-500"
            )}
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
      </Button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-11 z-50 w-96 rounded-lg border bg-card shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Active Alerts</span>
              {total > 0 && (
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-bold text-white",
                  critical > 0 ? "bg-red-600" : "bg-amber-500"
                )}>
                  {total}
                </span>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="max-h-[440px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center px-6">
                <div className="rounded-full bg-green-50 p-3">
                  <Bell className="h-5 w-5 text-green-600" />
                </div>
                <p className="text-sm font-medium text-foreground">All clear</p>
                <p className="text-xs text-muted-foreground">
                  No open non-conformances, complaints, field actions, flagged batches, or CAPA actions due soon.
                </p>
              </div>
            ) : (
              <div className="py-1">
                {groups.critical.length > 0 && (
                  <div>
                    <div className="sticky top-0 bg-red-50 border-b border-red-100 px-4 py-1.5 flex items-center gap-1.5">
                      <AlertCircle className="h-3 w-3 text-red-600" />
                      <span className="text-xs font-bold text-red-700 uppercase tracking-wide">
                        Requires Immediate Action ({groups.critical.length})
                      </span>
                    </div>
                    {groups.critical.map((n) => (
                      <NotificationRow key={n.id} n={n} onClose={() => setOpen(false)} />
                    ))}
                  </div>
                )}
                {groups.warning.length > 0 && (
                  <div>
                    <div className="sticky top-0 bg-amber-50 border-b border-amber-100 px-4 py-1.5 flex items-center gap-1.5">
                      <AlertTriangle className="h-3 w-3 text-amber-600" />
                      <span className="text-xs font-bold text-amber-700 uppercase tracking-wide">
                        Open Items ({groups.warning.length})
                      </span>
                    </div>
                    {groups.warning.map((n) => (
                      <NotificationRow key={n.id} n={n} onClose={() => setOpen(false)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="border-t px-4 py-2.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Updated {timeAgo(new Date().toISOString())} · refreshes every 60s
              </span>
              <Link
                href="/dashboard"
                className="text-xs font-medium text-primary hover:underline"
                onClick={() => setOpen(false)}
              >
                View dashboard →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationRow({ n, onClose }: { n: Notification; onClose: () => void }) {
  return (
    <Link href={n.href} onClick={onClose}>
      <div className={cn(
        "flex items-start gap-3 px-4 py-3 hover:bg-muted/50 cursor-pointer border-b border-border/40 last:border-0 transition-colors",
      )}>
        {categoryIcon(n.category, n.level)}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground truncate leading-snug">{n.title}</p>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">{n.subtitle}</p>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">{timeAgo(n.createdAt)}</span>
      </div>
    </Link>
  );
}
