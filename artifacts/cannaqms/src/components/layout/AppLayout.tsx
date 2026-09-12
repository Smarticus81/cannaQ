import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { UserButton, useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { HelpButton } from "@/components/help/HelpButton";
import { NewQualityEventButton } from "@/components/layout/NewQualityEventButton";
import { FacilitySwitcher } from "@/components/layout/FacilitySwitcher";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Building2,
  LayoutDashboard,
  Gauge,
  Users,
  ClipboardCheck,
  Package,
  Factory,
  AlertTriangle,
  MessageSquareWarning,
  ShieldAlert,
  Box,
  History,
  Settings,
  ClipboardList,
  GraduationCap,
  BookOpen,
  ShieldCheck,
  Tag,
  ChefHat,
  Flame,
  Radar,
  Scale,
  PackageCheck,
  LogOut,
  PanelLeft,
} from "lucide-react";

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; description: string;
  /** Only shown to somebody who works at more than one site (Phase 4, 2026-08-28). */
  multiSiteOnly?: boolean };
type NavSection = { heading?: string; items: NavItem[] };

// Per-item descriptions surface on hover (3s delay) as inline tooltips. Helps
// new users learn the QMS vocabulary without leaving the page. Keep descriptions
// concise — one or two sentences, plain language, no internal jargon.
const HOVER_DELAY_MS = 3000;

// Visually grouped navigation. The "Quality Events" section deliberately keeps
// NCs → Complaints → Field Actions → CAPA together so users see them as a
// single workflow family (a complaint may become an NC may spawn a CAPA, etc).
const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, description: "Overview of live operational and compliance metrics across your facility." },
      { name: "Documents", href: "/documents", icon: BookOpen, description: "Controlled SOPs, work instructions, forms, and specifications. Effective dates, versioning, and approvals tracked here. Kept at the top so a released WI or procedure is always one click away." },
      { name: "Management Review", href: "/management-review", icon: Gauge, description: "Standard quality-system health across the facility — the comprehensive Management Review view." },
    ],
  },
  {
    heading: "Receiving & Production",
    items: [
      { name: "Inspections", href: "/inspections", icon: ClipboardCheck, description: "Receipt-side inspection of materials as they enter your facility. Pass/fail determines whether material can be released to inventory." },
      { name: "Inventory", href: "/inventory", icon: Package, description: "On-hand quantities of ingredients and consumables, plus full lot-level traceability — drill from any item into its source lots and their history. Finished goods are handed to METRC and tracked there." },
      { name: "Finished Goods", href: "/finished-goods", icon: PackageCheck, description: "Finished-goods on hand read live from METRC (active packages). For reconciliation against physical counts during inventory checks." },
      { name: "Batches", href: "/batches", icon: Factory, description: "Production records covering the full batch lifecycle — ingredients in, testing, packaging, labeling, and release." },
      { name: "Recipes", href: "/recipes", icon: ChefHat, description: "Master formulations used to seed new batches. Locks in ingredients, ratios, and process for repeatable production." },
    ],
  },
  {
    heading: "Quality Events",
    items: [
      { name: "Non-Conformances", href: "/non-conformances", icon: AlertTriangle, description: "Any deviation from spec — failed test, out-of-tolerance result, supplier issue, inspection finding. Triage point for CAPAs." },
      { name: "Complaints", href: "/complaints", icon: MessageSquareWarning, description: "Customer complaints captured, triaged, and dispositioned. Can escalate into a Field Action when product is in the market." },
      { name: "Field Actions", href: "/field-actions", icon: ShieldAlert, description: "Recalls, stop sales, market withdrawals, and safety alerts for product already shipped. Generates customer notification letters and tracks closure." },
      { name: "CAPA", href: "/capas", icon: ClipboardList, description: "Corrective and Preventive Actions — root-cause-driven fixes that go beyond immediate containment. Approval-gated under Part 11." },
      { name: "Destruction Records", href: "/destruction-records", icon: Flame, description: "METRC destruction events for destroyed product. One tag can cover many batches; records link to the NCs that dispositioned product as Destroy." },
    ],
  },
  {
    heading: "Quality & Compliance",
    items: [
      { name: "Training", href: "/training", icon: GraduationCap, description: "Personnel training records — who is qualified to do what, when, and based on which SOP version." },
      { name: "Licenses", href: "/licenses", icon: Scale, description: "Facility and state operating licenses & certificates — the license file, number, and effective/expiry dates. Feeds the 4-month renewal watch on the Compliance dashboard." },
      { name: "Regulatory Intel", href: "/regulatory-intel", icon: Radar, description: "AI Regulatory Intelligence Agent. Ingests CRA/MDARD/FDA bulletins, summarizes them, and flags which of your SOPs and label templates may be impacted. You review and act." },
      { name: "Inventory Checks", href: "/inventory-checks", icon: ClipboardCheck, description: "Periodic physical inventory counts reconciled against METRC. Variances require a written reason and a Part 11 sign-off." },
      { name: "Suppliers", href: "/suppliers", icon: Users, description: "Approved vendors for cannabis material, packaging, production supplies, testing labs, and services. Source of every COA and license on file." },
      { name: "Approval & Certs", href: "/supplier-qualification", icon: ShieldCheck, description: "Supplier approval records — certificates on file (license, GMP/FDA, CoA) with issuer and expiry, plus optional audit assessments." },
      { name: "Label Studio", href: "/labels", icon: Tag, description: "Label template design and approval. Source of every printed batch label, with regulation references baked in." },
      { name: "Packaging", href: "/packaging", icon: Box, description: "Per-design packaging approval records with compliance checklists and artwork attachments." },
    ],
  },
  {
    items: [
      { name: "Corporate View", href: "/corporate", icon: Building2, description: "Every site you work at, side by side. Quality events belong to the company; batches, lots and training belong to the plant that made them. Only appears when you work at more than one site.", multiSiteOnly: true },
      { name: "Audit Log", href: "/audit-log", icon: History, description: "Immutable record of every change to a regulated table — who, what, when, before, after. Part 11 evidence." },
      { name: "Settings", href: "/settings", icon: Settings, description: "Company profile, user management, and state-specific regulatory configuration." },
    ],
  },
];

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/management-review": "Management Review",
  "/suppliers": "Suppliers",
  "/inspections": "Incoming Inspections",
  "/inventory": "Inventory",
  "/lots": "Lot Traceability",
  "/batches": "Batch Records",
  "/recipes": "Recipes",
  "/non-conformances": "Non-Conformances",
  "/complaints": "Complaints",
  "/field-actions": "Field Actions",
  "/capas": "CAPA",
  "/destruction-records": "Destruction Records",
  "/training": "Training Records",
  "/inventory-checks": "Inventory Checks",
  "/licenses": "Licenses & Certificates",
  "/documents": "Document Control",
  "/supplier-qualification": "Supplier Approval & Certificates",
  "/packaging": "Packaging Designs",
  "/audit-log": "Audit Log",
  "/settings": "Settings",
  "/corporate": "Corporate View",
};

function getPageTitle(location: string): string {
  for (const [path, title] of Object.entries(PAGE_TITLES)) {
    if (location === path || location.startsWith(`${path}/`)) return title;
  }
  return "CannaQ";
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  // How many sites this person works at. Anything marked multiSiteOnly stays hidden
  // below two — a single-site operator should see no trace of multi-facility at all,
  // which is the promise made when facilities were introduced.
  const { data: mySites } = useQuery<{ facilities: unknown[] }>({
    queryKey: ["me", "facilities"],
    queryFn: async () => {
      const r = await fetch("/api/me/facilities", { credentials: "include" });
      if (!r.ok) return { facilities: [] };
      return r.json();
    },
    staleTime: 60 * 1000,
  });
  const multiSite = (mySites?.facilities?.length ?? 0) > 1;
  const { signOut } = useClerk();
  // #11 (2026-08-03) — collapsible sidebar so the left rail can be narrowed
  // (kills horizontal scroll on wide NC/CAPA screens). Persisted in localStorage.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("sidebar-collapsed") === "1";
  });
  const toggleSidebar = () => {
    setCollapsed((v) => {
      const next = !v;
      if (typeof window !== "undefined") window.localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  };

  // ── Keep the sidebar where you left it ─────────────────────────────────────
  //
  // Every page wraps ITSELF in <AppLayout>, so a route change unmounts the whole
  // layout and builds it again — sidebar included — and the scroll snaps back to
  // the top. On a long nav that means hunting for where you were after every
  // click. The real cure is hoisting the layout above the router, which touches
  // every page; this remembers the position instead, so it is correct either way
  // and costs one file.
  //
  // sessionStorage, not localStorage: where you were in the nav belongs to this
  // tab and this sitting, not to the browser for ever.
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = navScrollRef.current;
    if (!el) return;
    try {
      const saved = window.sessionStorage.getItem("sidebar-scroll");
      if (saved) el.scrollTop = Number(saved) || 0;
    } catch { /* private mode / storage blocked — the nav just starts at the top */ }
  }, []);
  const rememberNavScroll = () => {
    const el = navScrollRef.current;
    if (!el) return;
    try { window.sessionStorage.setItem("sidebar-scroll", String(el.scrollTop)); } catch { /* ignore */ }
  };

  return (
    <TooltipProvider delayDuration={HOVER_DELAY_MS}>
    <div className="flex min-h-screen bg-[hsl(var(--app-canvas))]">
      {/* Sidebar */}
      <aside className={`${collapsed ? "w-16" : "w-64"} flex-col fixed inset-y-0 z-50 flex border-r bg-card`}>
        <div className={`flex h-16 shrink-0 items-center border-b overflow-hidden ${collapsed ? "justify-center px-2" : "px-6"}`}>
          <img src="/logo.svg" alt="CannaQ" className="h-8 w-auto" />
        </div>
        <div ref={navScrollRef} onScroll={rememberNavScroll} className="flex flex-1 flex-col overflow-y-auto">
          <nav className="flex-1 px-3 py-4">
            {NAV_SECTIONS.map((section, idx) => (
              <div key={section.heading ?? `nav-section-${idx}`} className={idx > 0 ? "mt-4" : ""}>
                {section.heading && !collapsed && (
                  <h3 className="px-2 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {section.heading}
                  </h3>
                )}
                <div className="space-y-0.5">
                  {section.items.filter((item) => !item.multiSiteOnly || multiSite).map((item) => {
                    const isActive = location === item.href || location.startsWith(`${item.href}/`);
                    return (
                      <Tooltip key={item.name} delayDuration={HOVER_DELAY_MS}>
                        <TooltipTrigger asChild>
                          <Link
                            href={item.href}
                            className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${collapsed ? "justify-center" : ""} ${
                              isActive
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            }`}
                            data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                          >
                            <item.icon
                              className={`${collapsed ? "" : "mr-3"} h-5 w-5 flex-shrink-0 ${
                                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                              }`}
                              aria-hidden="true"
                            />
                            {!collapsed && item.name}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right" align="start" className="max-w-xs text-xs leading-snug">
                          <span className="font-semibold block mb-0.5">{item.name}</span>
                          {item.description}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          {/* Session 108 — an explicit, always-visible Sign out control. The
              Clerk <UserButton/> avatar can silently fail to render when the
              session gets into a bad state, which once left the user unable to
              log out except via the dev console. This plain button calls the
              same sign-out directly, so a working logout is always present. */}
          <div className={`border-t space-y-3 ${collapsed ? "p-2" : "p-4"}`}>
            <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
              <UserButton />
              {!collapsed && <span className="text-sm font-medium text-muted-foreground">Account</span>}
            </div>
            <Button
              variant="outline"
              size="sm"
              className={`w-full gap-2 ${collapsed ? "justify-center px-0" : "justify-start"}`}
              onClick={() => { void signOut(); }}
              data-testid="button-sign-out"
            >
              <LogOut className="h-4 w-4" />
              {!collapsed && "Sign out"}
            </Button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className={`flex-1 ${collapsed ? "pl-16" : "pl-64"} flex flex-col min-h-screen min-w-0`}>
        {/* Top bar */}
        <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b bg-[hsl(var(--header-band))]/95 backdrop-blur-sm px-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={toggleSidebar} data-testid="button-toggle-sidebar" aria-label="Toggle sidebar">
              <PanelLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold text-foreground">{getPageTitle(location)}</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Which plant am I working at. Renders nothing at all for a
                single-site operator (Phase 4, 2026-08-28). */}
            <FacilitySwitcher />
            <NewQualityEventButton />
            <HelpButton />
            <ThemeToggle />
            <NotificationBell />
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 py-6">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 md:px-8">
            {children}
          </div>
        </div>
      </main>
    </div>
    </TooltipProvider>
  );
}
