import { BrandMark, RecordMark } from "@/components/BrandMark";
import { useState, useRef, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { onboardingDestination } from "@/lib/navigation";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { UserButton, useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { HelpButton } from "@/components/help/HelpButton";
import { NewQualityEventButton } from "@/components/layout/NewQualityEventButton";
import { FacilitySwitcher } from "@/components/layout/FacilitySwitcher";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  ChevronDown,
} from "lucide-react";

type NavItem = {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
  description: string;
  /** Only shown to somebody who works at more than one site (Phase 4, 2026-08-28). */
  multiSiteOnly?: boolean;
};
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
      {
        name: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        description:
          "Overview of live operational and compliance metrics across your facility.",
      },
      {
        name: "Documents",
        href: "/documents",
        icon: BookOpen,
        description:
          "Controlled SOPs, work instructions, forms, and specifications. Effective dates, versioning, and approvals tracked here. Kept at the top so a released WI or procedure is always one click away.",
      },
      {
        name: "Management Review",
        href: "/management-review",
        icon: Gauge,
        description:
          "Standard quality-system health across the facility — the comprehensive Management Review view.",
      },
    ],
  },
  {
    heading: "Receiving & Production",
    items: [
      {
        name: "Incoming Inspections",
        href: "/inspections",
        icon: ClipboardCheck,
        description:
          "Receipt-side inspection of materials as they enter your facility. Pass/fail determines whether material can be released to inventory.",
      },
      {
        name: "Inventory",
        href: "/inventory",
        icon: Package,
        description:
          "On-hand quantities of ingredients and consumables, plus full lot-level traceability — drill from any item into its source lots and their history. Finished goods are handed to METRC and tracked there.",
      },
      {
        name: "Finished Goods",
        href: "/finished-goods",
        icon: PackageCheck,
        description:
          "Finished-goods on hand read live from METRC (active packages). For reconciliation against physical counts during inventory checks.",
      },
      {
        name: "Batches",
        href: "/batches",
        icon: Factory,
        description:
          "Production records covering the full batch lifecycle — ingredients in, testing, packaging, labeling, and release.",
      },
      {
        name: "Recipes",
        href: "/recipes",
        icon: ChefHat,
        description:
          "Master formulations used to seed new batches. Locks in ingredients, ratios, and process for repeatable production.",
      },
    ],
  },
  {
    heading: "Quality Events",
    items: [
      {
        name: "Non-Conformances",
        href: "/non-conformances",
        icon: AlertTriangle,
        description:
          "Any deviation from spec — failed test, out-of-tolerance result, supplier issue, inspection finding. Triage point for CAPAs.",
      },
      {
        name: "Complaints",
        href: "/complaints",
        icon: MessageSquareWarning,
        description:
          "Customer complaints captured, triaged, and dispositioned. Can escalate into a Field Action when product is in the market.",
      },
      {
        name: "Field Actions",
        href: "/field-actions",
        icon: ShieldAlert,
        description:
          "Recalls, stop sales, market withdrawals, and safety alerts for product already shipped. Generates customer notification letters and tracks closure.",
      },
      {
        name: "CAPA",
        href: "/capas",
        icon: ClipboardList,
        description:
          "Corrective and Preventive Actions — root-cause-driven fixes that go beyond immediate containment. Approval-gated under Part 11.",
      },
      {
        name: "Destruction Records",
        href: "/destruction-records",
        icon: Flame,
        description:
          "METRC destruction events for destroyed product. One tag can cover many batches; records link to the NCs that dispositioned product as Destroy.",
      },
    ],
  },
  {
    heading: "Quality & Compliance",
    items: [
      {
        name: "Training",
        href: "/training",
        icon: GraduationCap,
        description:
          "Personnel training records — who is qualified to do what, when, and based on which SOP version.",
      },
      {
        name: "Licenses",
        href: "/licenses",
        icon: Scale,
        description:
          "Facility and state operating licenses & certificates — the license file, number, and effective/expiry dates. Feeds the 4-month renewal watch on the Compliance dashboard.",
      },
      {
        name: "Regulatory Intel",
        href: "/regulatory-intel",
        icon: Radar,
        description:
          "AI Regulatory Intelligence Agent. Ingests CRA/MDARD/FDA bulletins, summarizes them, and flags which of your SOPs and label templates may be impacted. You review and act.",
      },
      {
        name: "Inventory Checks",
        href: "/inventory-checks",
        icon: ClipboardCheck,
        description:
          "Periodic physical inventory counts reconciled against METRC. Variances require a written reason and a Part 11 sign-off.",
      },
      {
        name: "Suppliers",
        href: "/suppliers",
        icon: Users,
        description:
          "Approved vendors for cannabis material, packaging, production supplies, testing labs, and services. Source of every COA and license on file.",
      },
      {
        name: "Supplier Approval",
        href: "/supplier-qualification",
        icon: ShieldCheck,
        description:
          "Supplier approval records — certificates on file (license, GMP/FDA, CoA) with issuer and expiry, plus optional audit assessments.",
      },
      {
        name: "Label Studio",
        href: "/labels",
        icon: Tag,
        description:
          "Label template design and approval. Source of every printed batch label, with regulation references baked in.",
      },
      {
        name: "Packaging",
        href: "/packaging",
        icon: Box,
        description:
          "Per-design packaging approval records with compliance checklists and artwork attachments.",
      },
    ],
  },
  {
    items: [
      {
        name: "Corporate View",
        href: "/corporate",
        icon: Building2,
        description:
          "Every site you work at, side by side. Quality events belong to the company; batches, lots and training belong to the plant that made them. Only appears when you work at more than one site.",
        multiSiteOnly: true,
      },
      {
        name: "Audit Log",
        href: "/audit-log",
        icon: History,
        description:
          "Immutable record of every change to a regulated table — who, what, when, before, after. Part 11 evidence.",
      },
      {
        name: "Settings",
        href: "/settings",
        icon: Settings,
        description:
          "Company profile, user management, and state-specific regulatory configuration.",
      },
    ],
  },
];

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/finished-goods": "Finished Goods",
  "/labels": "Label Studio",
  "/regulatory-intel": "Regulatory Intelligence",
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

export function WorkspaceLayout({
  children,
  multiSite = false,
  account,
  toolbar,
  onSignOut,
  signingOut = false,
}: {
  children: React.ReactNode;
  multiSite?: boolean;
  account?: React.ReactNode;
  toolbar?: React.ReactNode;
  onSignOut?: () => void;
  signingOut?: boolean;
}) {
  const [location] = useLocation();
  const [navSearch, setNavSearch] = useState("");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => {
      let remembered: Record<string, boolean> = {};
      try {
        remembered = JSON.parse(
          sessionStorage.getItem("cannaq-nav-sections") || "{}",
        );
      } catch {
        /* Start with the current work area. */
      }
      for (const section of NAV_SECTIONS) {
        if (
          section.heading &&
          section.items.some(
            (item) =>
              location === item.href || location.startsWith(`${item.href}/`),
          )
        )
          remembered[section.heading] = true;
      }
      return remembered;
    },
  );
  const toggleSection = (heading: string) =>
    setOpenSections((previous) => {
      const next = { ...previous, [heading]: !previous[heading] };
      try {
        sessionStorage.setItem("cannaq-nav-sections", JSON.stringify(next));
      } catch {
        /* Keep working without browser storage. */
      }
      return next;
    });
  const [mobileOpen, setMobileOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const previousLocation = useRef(location);
  useEffect(() => {
    document.title = `${getPageTitle(location)} · CannaQ`;
    if (previousLocation.current === location) return;
    previousLocation.current = location;
    setMobileOpen(false);
    setNavSearch("");
    const section = NAV_SECTIONS.find((section) =>
      section.items.some(
        (item) =>
          location === item.href || location.startsWith(`${item.href}/`),
      ),
    );
    if (section?.heading) {
      const heading = section.heading;
      setOpenSections((previous) => ({ ...previous, [heading]: true }));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    const frame = requestAnimationFrame(() =>
      document
        .getElementById("workspace-content")
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [location]);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const wasMobileOpen = useRef(false);
  useEffect(() => {
    // Restore focus after React removes inert from the main workspace.
    if (wasMobileOpen.current && !mobileOpen) mobileToggleRef.current?.focus();
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen]);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    asideRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        asideRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
        ) ?? [],
      ).filter((item) => item.getClientRects().length > 0);
      if (!items?.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", keydown);
    };
  }, [mobileOpen]);
  // #11 (2026-08-03) — collapsible sidebar so the left rail can be narrowed
  // (kills horizontal scroll on wide NC/CAPA screens). Persisted in localStorage.
  const [sidebarCollapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [smallScreen, setSmallScreen] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setSmallScreen(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const collapsed = sidebarCollapsed && !smallScreen;
  const toggleSidebar = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      } catch {
        /* The navigation still works when browser storage is disabled. */
      }
      return next;
    });
  };

  // Restore the navigation position when returning from setup or reloading.
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = navScrollRef.current;
    if (!el) return;
    try {
      const saved = window.sessionStorage.getItem("sidebar-scroll");
      if (saved) el.scrollTop = Number(saved) || 0;
    } catch {
      /* private mode / storage blocked — the nav just starts at the top */
    }
  }, []);
  const rememberNavScroll = () => {
    const el = navScrollRef.current;
    if (!el) return;
    try {
      window.sessionStorage.setItem("sidebar-scroll", String(el.scrollTop));
    } catch {
      /* ignore */
    }
  };

  return (
    <TooltipProvider delayDuration={HOVER_DELAY_MS}>
      <a className="cq-skip-link" href="#workspace-content">
        Skip to content
      </a>
      <div
        className={`cq-shell ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "mobile-open" : ""} flex min-h-screen bg-[hsl(var(--app-canvas))]`}
      >
        <button
          className="cq-nav-scrim"
          onClick={() => {
            setMobileOpen(false);
          }}
          aria-label="Close navigation"
          tabIndex={-1}
        />
        {/* Sidebar */}
        <aside
          inert={smallScreen && !mobileOpen}
          ref={asideRef}
          id="workspace-navigation"
          aria-label="Workspace navigation"
          className={`${collapsed ? "w-16" : "w-64"} flex-col fixed inset-y-0 z-50 flex border-r bg-card`}
        >
          <div
            className={`flex h-16 shrink-0 items-center border-b overflow-hidden ${collapsed ? "justify-center px-2" : "px-6"}`}
          >
            {collapsed ? (
              <Link href="/dashboard" aria-label="CannaQ dashboard">
                <RecordMark className="h-8 w-8" />
              </Link>
            ) : (
              <BrandMark href="/dashboard" />
            )}
          </div>
          <div
            ref={navScrollRef}
            onScroll={rememberNavScroll}
            className="flex flex-1 flex-col overflow-y-auto"
          >
            <nav className="flex-1 px-3 py-4" aria-label="Work areas">
              {!collapsed && (
                <div className="cq-nav-search">
                  <label className="sr-only" htmlFor="navigation-search">
                    Find a work area
                  </label>
                  <input
                    id="navigation-search"
                    placeholder="Find a work area…"
                    value={navSearch}
                    onChange={(event) => setNavSearch(event.target.value)}
                  />
                </div>
              )}
              {NAV_SECTIONS.filter((section) =>
                section.items.some(
                  (item) =>
                    (!item.multiSiteOnly || multiSite) &&
                    item.name.toLowerCase().includes(navSearch.toLowerCase()),
                ),
              ).map((section, idx) => (
                <div
                  key={section.heading ?? `nav-section-${idx}`}
                  className={idx > 0 ? "mt-4" : ""}
                >
                  {section.heading && !collapsed && (
                    <button
                      type="button"
                      className="cq-nav-section"
                      onClick={() => toggleSection(section.heading!)}
                      aria-expanded={
                        !!navSearch || !!openSections[section.heading]
                      }
                      aria-controls={`nav-group-${idx}`}
                    >
                      {section.heading}
                      <ChevronDown size={12} />
                    </button>
                  )}
                  <div
                    id={`nav-group-${idx}`}
                    hidden={
                      !collapsed &&
                      !!section.heading &&
                      !navSearch &&
                      !openSections[section.heading]
                    }
                    className="space-y-0.5"
                  >
                    {section.items
                      .filter(
                        (item) =>
                          (!item.multiSiteOnly || multiSite) &&
                          item.name
                            .toLowerCase()
                            .includes(navSearch.toLowerCase()),
                      )
                      .map((item) => {
                        const isActive =
                          location === item.href ||
                          location.startsWith(`${item.href}/`);
                        return (
                          <Tooltip
                            key={item.name}
                            delayDuration={HOVER_DELAY_MS}
                          >
                            <TooltipTrigger asChild>
                              <Link
                                href={item.href}
                                aria-label={item.name}
                                aria-current={isActive ? "page" : undefined}
                                className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${collapsed ? "justify-center" : ""} ${
                                  isActive
                                    ? "bg-primary/10 text-primary"
                                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                }`}
                                data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                              >
                                <item.icon
                                  className={`${collapsed ? "" : "mr-3"} h-5 w-5 flex-shrink-0 ${
                                    isActive
                                      ? "text-primary"
                                      : "text-muted-foreground group-hover:text-foreground"
                                  }`}
                                  aria-hidden="true"
                                />
                                {!collapsed && item.name}
                              </Link>
                            </TooltipTrigger>
                            <TooltipContent
                              side="right"
                              align="start"
                              className="max-w-xs text-xs leading-snug"
                            >
                              <span className="font-semibold block mb-0.5">
                                {item.name}
                              </span>
                              {item.description}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                  </div>
                </div>
              ))}
              {navSearch &&
                !NAV_SECTIONS.some((section) =>
                  section.items.some(
                    (item) =>
                      (!item.multiSiteOnly || multiSite) &&
                      item.name.toLowerCase().includes(navSearch.toLowerCase()),
                  ),
                ) && (
                  <p role="status" className="cq-microcopy px-2 py-4">
                    No matching work area. Try another name.
                  </p>
                )}
            </nav>
            {/* Session 108 — an explicit, always-visible Sign out control. The
              Clerk <UserButton/> avatar can silently fail to render when the
              session gets into a bad state, which once left the user unable to
              log out except via the dev console. This plain button calls the
              same sign-out directly, so a working logout is always present. */}
            <div className={`border-t space-y-3 ${collapsed ? "p-2" : "p-4"}`}>
              <Link
                href={onboardingDestination(location + window.location.search)}
                className="cq-text-action"
                aria-label="Workspace setup and preferences"
              >
                {collapsed ? "Setup" : "Setup & preferences"}
              </Link>
              <div
                className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}
              >
                {account}
                {!collapsed && (
                  <span className="text-sm font-medium text-muted-foreground">
                    Account
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className={`w-full gap-2 ${collapsed ? "justify-center px-0" : "justify-start"}`}
                onClick={onSignOut}
                disabled={signingOut}
                aria-busy={signingOut}
                data-testid="button-sign-out"
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
                {!collapsed && (signingOut ? "Signing out…" : "Sign out")}
              </Button>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main
          inert={smallScreen && mobileOpen}
          className={`flex-1 ${collapsed ? "pl-16" : "pl-64"} flex flex-col min-h-screen min-w-0`}
        >
          {/* Top bar */}
          <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b bg-[hsl(var(--header-band))]/95 backdrop-blur-sm px-6">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                ref={mobileToggleRef}
                className="cq-mobile-nav-toggle h-8 w-8"
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
                aria-controls="workspace-navigation"
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="cq-desktop-nav-toggle h-8 w-8 shrink-0"
                onClick={toggleSidebar}
                data-testid="button-toggle-sidebar"
                aria-label="Toggle sidebar"
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold text-foreground">
                {getPageTitle(location)}
              </span>
            </div>
            <div className="flex items-center gap-2">{toolbar}</div>
          </header>

          {/* Page content */}
          <div className="flex-1 py-6">
            <div
              id="workspace-content"
              tabIndex={-1}
              className="mx-auto max-w-7xl px-4 sm:px-6 md:px-8"
            >
              {children}
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
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
  const { toast } = useToast();
  const [signingOut, setSigningOut] = useState(false);
  const exitWorkspace = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut({
        redirectUrl: `${import.meta.env.BASE_URL.replace(/\/$/, "")}/`,
      });
    } catch {
      toast({
        title: "Could not sign out",
        description:
          "Your session is still open. Check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setSigningOut(false);
    }
  };
  return (
    <WorkspaceLayout
      multiSite={multiSite}
      account={<UserButton />}
      onSignOut={() => void exitWorkspace()}
      signingOut={signingOut}
      toolbar={
        <>
          <FacilitySwitcher />
          <NewQualityEventButton />
          <HelpButton />
          <ThemeToggle />
          <NotificationBell />
        </>
      }
    >
      {children}
    </WorkspaceLayout>
  );
}
