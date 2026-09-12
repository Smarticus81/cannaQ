import { lazy, Suspense, useEffect, useRef, type PropsWithChildren } from "react";
import { ClerkProvider, RedirectToSignIn, SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/ErrorBoundary";
const NotFound = lazy(() => import("@/pages/not-found"));

const Landing = lazy(() => import("@/pages/Landing"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Suppliers = lazy(() => import("@/pages/Suppliers"));
const SupplierDetail = lazy(() => import("@/pages/SupplierDetail"));
const Inspections = lazy(() => import("@/pages/Inspections"));
const InspectionDetail = lazy(() => import("@/pages/InspectionDetail"));
const Inventory = lazy(() => import("@/pages/Inventory"));
const FinishedGoods = lazy(() => import("@/pages/FinishedGoods"));
const Licenses = lazy(() => import("@/pages/Licenses"));
const InventoryChecks = lazy(() => import("@/pages/InventoryChecks"));
const InventoryCheckDetail = lazy(() => import("@/pages/InventoryCheckDetail"));
const LotDetail = lazy(() => import("@/pages/LotDetail"));
const Batches = lazy(() => import("@/pages/Batches"));
const BatchDetail = lazy(() => import("@/pages/BatchDetail"));
const Recipes = lazy(() => import("@/pages/Recipes"));
const RecipeDetail = lazy(() => import("@/pages/RecipeDetail"));
const NonConformances = lazy(() => import("@/pages/NonConformances"));
const NonConformanceDetail = lazy(() => import("@/pages/NonConformanceDetail"));
const DestructionRecords = lazy(() => import("@/pages/DestructionRecords"));
const DestructionRecordDetail = lazy(() => import("@/pages/DestructionRecordDetail"));
const Complaints = lazy(() => import("@/pages/Complaints"));
const ComplaintDetail = lazy(() => import("@/pages/ComplaintDetail"));
const FieldActions = lazy(() => import("@/pages/FieldActions"));
const FieldActionDetail = lazy(() => import("@/pages/FieldActionDetail"));
const Packaging = lazy(() => import("@/pages/Packaging"));
const PackagingDetail = lazy(() => import("@/pages/PackagingDetail"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const AuditLogReport = lazy(() => import("@/pages/AuditLogReport"));
const SupplierRequalAuditTrail = lazy(() => import("@/pages/SupplierRequalAuditTrail"));
const Settings = lazy(() => import("@/pages/Settings"));
const Corporate = lazy(() => import("@/pages/Corporate"));
const CAPAs = lazy(() => import("@/pages/CAPAs"));
const CAPADetail = lazy(() => import("@/pages/CAPADetail"));
const Training = lazy(() => import("@/pages/Training"));
const TrainingDetail = lazy(() => import("@/pages/TrainingDetail"));
const Documents = lazy(() => import("@/pages/Documents"));
const LabelStudio = lazy(() => import("@/pages/LabelStudio"));
const RegulatoryIntelligence = lazy(() => import("@/pages/RegulatoryIntelligence"));
const DocumentDetail = lazy(() => import("@/pages/DocumentDetail"));
const DocumentRevisionView = lazy(() => import("@/pages/DocumentRevisionView"));
const SupplierQualification = lazy(() => import("@/pages/SupplierQualification"));
const SupplierQualificationDetail = lazy(() => import("@/pages/SupplierQualificationDetail"));
const ManagementReview = lazy(() => import("@/pages/ManagementReview"));
const ManagementReviewRecord = lazy(() => import("@/pages/ManagementReviewRecord"));

const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

if (!clerkPubKey) throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    logoPlacement: "inside" as const,
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-2xl w-[440px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground",
    headerSubtitle: "text-muted-foreground",
    formFieldLabel: "text-foreground",
    formFieldInput: "bg-input text-foreground",
    footerActionLink: "text-primary",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground",
    formButtonPrimary: "bg-primary text-primary-foreground",
  },
  variables: {
    colorPrimary: "#16a34a",
    colorForeground: "#0f172a",
    colorMutedForeground: "#64748b",
    colorBackground: "#ffffff",
    colorInput: "#f8fafc",
    colorInputForeground: "#0f172a",
    colorDanger: "#dc2626",
    colorNeutral: "#cbd5e1",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.5rem",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) queryClient.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);
  return null;
}

function RequireRouteSession({ children }: PropsWithChildren) {
  const [location] = useLocation();
  const { isLoaded, isSignedIn } = useAuth();
  const publicRoute = location === "/" || /^\/sign-(in|up)(\/|$)/.test(location);
  if (publicRoute) return children;
  if (!isLoaded) return <div role="status" className="p-8 text-center">Loading…</div>;
  if (!isSignedIn) return <RedirectToSignIn />;
  return children;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Welcome to CannaQ", subtitle: "Sign in to access the quality management system" } },
        signUp: { start: { title: "Create your account", subtitle: "Get started with CannaQ" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          {/* Session 42 (25 May feedback fix): wrap routes in ErrorBoundary so a
              render/parse error in one page doesn't unmount the whole tree and
              leave a blank screen. See components/ErrorBoundary.tsx for the
              root-cause analysis. */}
          <ErrorBoundary>
          <RequireRouteSession>
          <Suspense fallback={<div role="status" className="flex min-h-[50vh] items-center justify-center text-muted-foreground">Loading…</div>}>
          <Switch>
            <Route path="/" component={Landing} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/corporate" component={Corporate} />
            <Route path="/management-review" component={ManagementReview} />
            <Route path="/management-review/reviews/:id" component={ManagementReviewRecord} />
            <Route path="/suppliers" component={Suppliers} />
            <Route path="/suppliers/:id" component={SupplierDetail} />
            <Route path="/inspections" component={Inspections} />
            <Route path="/inspections/:id" component={InspectionDetail} />
            <Route path="/inventory" component={Inventory} />
            <Route path="/finished-goods" component={FinishedGoods} />
            <Route path="/inventory-checks" component={InventoryChecks} />
            <Route path="/inventory-checks/:id" component={InventoryCheckDetail} />
            <Route path="/licenses" component={Licenses} />
            {/* Lots collapsed into Inventory (one section). The list now lives on
                the Inventory "Lot Traceability" view; per-lot detail stays at
                /lots/:id. Redirect the old list URL so existing links land right. */}
            <Route path="/lots">{() => <Redirect to="/inventory" />}</Route>
            <Route path="/lots/:id" component={LotDetail} />
            <Route path="/batches" component={Batches} />
            <Route path="/batches/:id" component={BatchDetail} />
            <Route path="/recipes" component={Recipes} />
            <Route path="/recipes/:id" component={RecipeDetail} />
            <Route path="/non-conformances" component={NonConformances} />
            <Route path="/non-conformances/:id" component={NonConformanceDetail} />
            <Route path="/destruction-records" component={DestructionRecords} />
            <Route path="/destruction-records/:id" component={DestructionRecordDetail} />
            <Route path="/complaints" component={Complaints} />
            <Route path="/complaints/:id" component={ComplaintDetail} />
            <Route path="/field-actions" component={FieldActions} />
            <Route path="/field-actions/:id" component={FieldActionDetail} />
            <Route path="/packaging" component={Packaging} />
            <Route path="/packaging/:id" component={PackagingDetail} />
            <Route path="/capas" component={CAPAs} />
            <Route path="/capas/:id" component={CAPADetail} />
            <Route path="/training" component={Training} />
            <Route path="/training/:id" component={TrainingDetail} />
            <Route path="/documents" component={Documents} />
            <Route path="/regulatory-intel" component={RegulatoryIntelligence} />
            <Route path="/labels" component={LabelStudio} />
            <Route path="/documents/:id/revisions/:rowId" component={DocumentRevisionView} />
            <Route path="/documents/:id" component={DocumentDetail} />
            <Route path="/supplier-qualification" component={SupplierQualification} />
            <Route path="/supplier-qualification/:id" component={SupplierQualificationDetail} />
            <Route path="/audit-log/supplier-requal" component={SupplierRequalAuditTrail} />
            <Route path="/audit-log/report" component={AuditLogReport} />
            <Route path="/audit-log" component={AuditLog} />
            <Route path="/settings" component={Settings} />
            <Route component={NotFound} />
          </Switch>
          </Suspense>
          </RequireRouteSession>
          </ErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
