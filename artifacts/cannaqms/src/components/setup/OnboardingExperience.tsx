import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Moon,
  Sun,
  Monitor,
  Leaf,
  ShieldCheck,
  Waypoints,
  RotateCcw,
} from "lucide-react";
import { onboardingPaths } from "@workspace/api-zod/onboarding-paths";
import type {
  OnboardingDraft,
  OnboardingSnapshot,
} from "@workspace/api-zod/onboarding";
import { BrandMark } from "@/components/BrandMark";

const CHAPTERS = [
  "Overview",
  "Account identity",
  "Licensed facility",
  "Display & density",
  "Starting workflow",
  "Review & activate",
];
const HEADLINES = [
  <>
    Set up your
    <br />
    CannaQ workspace.
  </>,
  <>
    Confirm your
    <br />
    record identity.
  </>,
  <>
    Connect your work
    <br />
    to a licensed facility.
  </>,
  <>
    Adjust your
    <br />
    working view.
  </>,
  <>
    Choose your
    <br />
    starting workflow.
  </>,
  <>
    Review your setup.
    <br />
    Then get to work.
  </>,
];
const NOTES = [
  "Progress is saved to your account as you work.",
  "This confirmation does not apply an electronic signature.",
  "One facility connects its people, licence, and operating records.",
  "Display preferences apply to your account only.",
  "Your starting workflow does not change your access permissions.",
  "Facility settings are applied when you activate your workspace.",
];
const TIME_ZONES = [
  "America/Detroit",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export type OnboardingExperienceProps = {
  snapshot: OnboardingSnapshot;
  draft: OnboardingDraft;
  saveStatus: "saved" | "saving" | "unsaved" | "error";
  busy?: boolean;
  error?: { message: string; field?: string; conflict?: boolean } | null;
  paused?: boolean;
  onChange: (change: Partial<OnboardingDraft>) => void;
  onNavigate: (step: number) => Promise<void>;
  onComplete: () => Promise<void>;
  onDefer: () => Promise<void>;
  onRetry: () => void;
  onReload: () => void;
  onResume: () => void;
  onExit?: () => void;
};

export function OnboardingExperience(props: OnboardingExperienceProps) {
  const {
    snapshot,
    draft,
    busy,
    error,
    paused,
    onChange,
    onNavigate,
    onComplete,
    onDefer,
    onRetry,
    onReload,
    onResume,
    onExit,
  } = props;
  const [validation, setValidation] = useState<Record<string, string>>({});
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const step = draft.step;
  const returning =
    !!snapshot.completedAt &&
    !snapshot.needsWorkspace &&
    !snapshot.accessPending;
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    setValidation({});
  }, [step, paused, snapshot.accessPending]);

  const errorFor = (field: string) =>
    validation[field] || (error?.field === field ? error.message : "");
  const field = (
    key: "companyName" | "facilityName" | "licenseNumber",
    label: string,
    placeholder: string,
  ) => (
    <div className="cq-field">
      <label htmlFor={key}>{label}</label>
      <input
        id={key}
        name={key}
        autoComplete="off"
        value={draft[key]}
        placeholder={placeholder}
        maxLength={key === "licenseNumber" ? 100 : 160}
        onChange={(event) => {
          onChange({ [key]: event.target.value });
          setValidation((v) => ({ ...v, [key]: "" }));
        }}
        aria-invalid={!!errorFor(key)}
        aria-describedby={errorFor(key) ? `${key}-error` : undefined}
      />
      {errorFor(key) && (
        <span id={`${key}-error`} className="cq-field-error">
          {errorFor(key)}
        </span>
      )}
    </div>
  );

  async function advance(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (step === 1 && !draft.identityConfirmed)
      nextErrors.identityConfirmed = "Confirm these details before continuing.";
    if (step === 2 && snapshot.needsWorkspace) {
      for (const key of [
        "companyName",
        "facilityName",
        "licenseNumber",
      ] as const)
        if (!draft[key].trim()) nextErrors[key] = "Please add this detail.";
      if (!/^[A-Z]{2}$/.test(draft.state))
        nextErrors.state = "Enter your two-letter state code.";
    }
    if (Object.keys(nextErrors).length) {
      setValidation(nextErrors);
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    if (step === 5) await onComplete();
    else await onNavigate(step + 1);
  }

  const selectedPath = onboardingPaths[draft.focus];
  return (
    <div className="cq-onboarding" data-testid="onboarding">
      <aside className="cq-onboarding-aside">
        <BrandMark inverse />
        <div className="cq-aside-intro">
          <span className="cq-eyebrow">WORKSPACE REGISTRATION</span>
          <p>
            Account.
            <br />
            Facility.
            <br />
            Workflow.
          </p>
          <span className="cq-aside-subtitle">
            Six steps to a working setup.
          </span>
        </div>
        <nav className="cq-chapters" aria-label="Setup steps">
          {CHAPTERS.map((chapter, index) => (
            <button
              type="button"
              key={chapter}
              aria-label={`Step ${index + 1}: ${chapter}`}
              className={`cq-chapter ${index === step ? "is-current" : ""} ${index < step ? "is-complete" : ""}`}
              disabled={busy || (!returning && index > step) || paused}
              onClick={() => void onNavigate(index)}
              aria-current={step === index ? "step" : undefined}
            >
              <span className="cq-chapter-number">
                {index < step ? (
                  <Check size={13} />
                ) : (
                  String(index + 1).padStart(2, "0")
                )}
              </span>
              <span>{chapter}</span>
            </button>
          ))}
        </nav>
        <div className="cq-aside-note">
          <span className="cq-eyebrow">CANNAQ / QMS</span>
          <p>
            Controlled records.
            <br />
            Connected operations.
          </p>
        </div>
      </aside>
      <main className="cq-onboarding-main">
        <header className="cq-onboarding-header">
          <span className="cq-eyebrow">
            {returning ? "WORKSPACE PREFERENCES" : "WORKSPACE SETUP"}
          </span>
          <div className="cq-save-state" role="status" aria-live="polite">
            {props.saveStatus === "saved" ? (
              <>
                <CheckCheck size={14} /> All changes saved
              </>
            ) : props.saveStatus === "saving" ? (
              "Saving changes…"
            ) : props.saveStatus === "error" ? (
              "Changes need saving"
            ) : (
              "Unsaved changes"
            )}
          </div>
          {onExit && (
            <button
              className="cq-text-action shrink-0"
              onClick={onExit}
              disabled={busy}
            >
              Save & sign out
            </button>
          )}
        </header>
        {paused ? (
          <section className="cq-onboarding-content cq-pause">
            <span className="cq-eyebrow">SETUP PAUSED</span>
            <h1 tabIndex={-1} ref={headingRef}>
              Your setup
              <br />
              is saved.
            </h1>
            <p className="cq-lead">
              Your draft is saved to your account. Resume this setup when you
              are ready to continue.
            </p>
            {error && (
              <p role="alert" className="text-destructive">
                {error.message}
              </p>
            )}
            <button className="cq-action" onClick={onResume} disabled={busy}>
              Resume setup <ArrowRight size={18} />
            </button>
          </section>
        ) : (
          <form
            className="cq-onboarding-form"
            ref={formRef}
            onSubmit={(event) => void advance(event)}
            noValidate
          >
            <fieldset
              className="cq-onboarding-content"
              key={step}
              disabled={busy}
            >
              <div className="cq-chapter-heading">
                <span className="cq-eyebrow">
                  STEP {String(step + 1).padStart(2, "0")}{" "}
                  <span className="cq-heading-rule" /> {CHAPTERS[step]}
                </span>
                <h1 tabIndex={-1} ref={headingRef}>
                  {HEADLINES[step]}
                </h1>
              </div>
              {step === 0 && (
                <div className="cq-step-body">
                  <p className="cq-lead">
                    {snapshot.user.fullName.split(" ")[0]}, confirm your
                    account, connect to your facility, and choose how you want
                    to work. You can save and return at any point.
                  </p>
                  <div className="cq-welcome-notes">
                    <div>
                      <span>01</span>
                      <p>
                        <strong>Establish your identity</strong>
                        <br />
                        Confirm the name and initials attached to your records.
                      </p>
                    </div>
                    <div>
                      <span>02</span>
                      <p>
                        <strong>Confirm your licensed facility</strong>
                        <br />
                        Keep operating records connected to the correct site.
                      </p>
                    </div>
                    <div>
                      <span>03</span>
                      <p>
                        <strong>Choose a starting workflow</strong>
                        <br />
                        Begin with document control, production, or inventory.
                      </p>
                    </div>
                  </div>
                  <fieldset className="cq-inline-choice">
                    <legend>
                      Your experience with quality management systems
                    </legend>
                    {[
                      ["new", "New to quality systems"],
                      ["familiar", "Experienced QMS user"],
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="experience"
                          value={value}
                          checked={draft.experience === value}
                          onChange={() =>
                            onChange({
                              experience:
                                value as OnboardingDraft["experience"],
                            })
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}
              {step === 1 && (
                <div className="cq-step-body">
                  <p className="cq-lead">
                    Your name and initials identify your actions in CannaQ. Your
                    assigned role controls the actions available to you.
                  </p>
                  <div className="cq-identity">
                    <span className="cq-monogram">
                      {snapshot.user.initials}
                    </span>
                    <div>
                      <h2>{snapshot.user.fullName}</h2>
                      <p>
                        {snapshot.user.role} <span>·</span> Assigned by your
                        administrator
                      </p>
                    </div>
                  </div>
                  <div className="cq-explainer">
                    <ShieldCheck size={22} />
                    <p>
                      Check this identity before creating or reviewing records.
                      Electronic signatures require a separate signing action;
                      this confirmation is not a signature.
                    </p>
                  </div>
                  <label className="cq-confirm">
                    <input
                      type="checkbox"
                      checked={draft.identityConfirmed}
                      onChange={(event) => {
                        onChange({ identityConfirmed: event.target.checked });
                        setValidation({});
                      }}
                      aria-invalid={!!errorFor("identityConfirmed")}
                    />
                    <span>These are my name and initials.</span>
                  </label>
                  {errorFor("identityConfirmed") && (
                    <p className="cq-field-error" role="alert">
                      {errorFor("identityConfirmed")}
                    </p>
                  )}
                  <p className="cq-microcopy">
                    Something doesn't look right? Ask your administrator to
                    update your account before you sign any records.
                  </p>
                </div>
              )}
              {step === 2 && (
                <div className="cq-step-body">
                  {snapshot.accessPending ? (
                    <div className="cq-access-wait">
                      <span className="cq-eyebrow">
                        FACILITY ASSIGNMENT REQUIRED
                      </span>
                      <h2>Your facility access is pending.</h2>
                      <p>
                        Your administrator needs to assign your account to a
                        facility. Your setup progress stays saved while they
                        make that connection.
                      </p>
                      <button
                        type="button"
                        className="cq-text-action"
                        onClick={onReload}
                      >
                        <RotateCcw size={15} /> Check my access again
                      </button>
                    </div>
                  ) : snapshot.needsWorkspace ? (
                    <>
                      <p className="cq-lead">
                        Enter the company and licensed site that will own your
                        operating records. These details remain a draft until
                        you finish setup.
                      </p>
                      {field(
                        "companyName",
                        "Company name",
                        "Registered or trading name",
                      )}
                      {field(
                        "facilityName",
                        "Facility name",
                        "Site name, e.g. Ann Arbor Processing",
                      )}
                      {field(
                        "licenseNumber",
                        "Facility licence number",
                        "As shown on your operating licence",
                      )}
                      <div className="cq-field-pair">
                        <div className="cq-field">
                          <label htmlFor="state">State</label>
                          <input
                            id="state"
                            value={draft.state}
                            maxLength={2}
                            autoComplete="address-level1"
                            onChange={(event) =>
                              onChange({
                                state: event.target.value.toUpperCase(),
                              })
                            }
                            aria-invalid={!!errorFor("state")}
                          />
                          {errorFor("state") && (
                            <span className="cq-field-error">
                              {errorFor("state")}
                            </span>
                          )}
                        </div>
                        <div className="cq-field">
                          <label htmlFor="timeZone">Facility time zone</label>
                          <select
                            id="timeZone"
                            value={draft.timeZone}
                            onChange={(event) =>
                              onChange({ timeZone: event.target.value })
                            }
                          >
                            {Array.from(
                              new Set([...TIME_ZONES, draft.timeZone]),
                            ).map((zone) => (
                              <option key={zone} value={zone}>
                                {zone
                                  .replace("America/", "")
                                  .replaceAll("_", " ")}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="cq-microcopy">
                        Metrc and your wider operating settings can be connected
                        later, in Settings.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="cq-lead">
                        Your organization has already configured this workspace.
                        Confirm the site where you will begin working.
                      </p>
                      <div className="cq-workspace-summary">
                        <span className="cq-eyebrow">
                          {snapshot.companyName || "YOUR WORKSPACE"}
                        </span>
                        <h2>{snapshot.facility?.name}</h2>
                        <p>
                          {snapshot.facility?.state} <span> / </span>{" "}
                          {snapshot.facility?.timeZone
                            ?.replace("America/", "")
                            .replaceAll("_", " ") || "Facility time zone"}
                        </p>
                        <div className="cq-summary-rule" />
                        <span className="cq-microcopy">Operating licence</span>
                        <p className="cq-license">
                          {snapshot.facility?.licenseNumber ||
                            "Your administrator will add this"}
                        </p>
                      </div>
                      {snapshot.facilities.length > 1 && (
                        <div className="cq-field">
                          <label htmlFor="facilityId">
                            Where will you begin?
                          </label>
                          <select
                            id="facilityId"
                            value={draft.facilityId ?? snapshot.facility?.id}
                            onChange={(event) =>
                              onChange({
                                facilityId: Number(event.target.value),
                              })
                            }
                          >
                            {snapshot.facilities.map((facility) => (
                              <option key={facility.id} value={facility.id}>
                                {facility.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              {step === 3 && (
                <div className="cq-step-body">
                  <p className="cq-lead">
                    Set the display and information density for your working
                    environment. These preferences do not change facility
                    records.
                  </p>
                  <fieldset className="cq-theme-options">
                    <legend>Display mode</legend>
                    {(
                      [
                        {
                          value: "light",
                          title: "Light",
                          note: "Clear contrast for office use.",
                          Icon: Sun,
                        },
                        {
                          value: "dark",
                          title: "Dark",
                          note: "Reduced brightness for low light.",
                          Icon: Moon,
                        },
                        {
                          value: "system",
                          title: "System",
                          note: "Use your device setting.",
                          Icon: Monitor,
                        },
                      ] as const
                    ).map(({ value, title, note, Icon }) => (
                      <label
                        key={value}
                        className={draft.theme === value ? "is-selected" : ""}
                      >
                        <input
                          type="radio"
                          name="theme"
                          checked={draft.theme === value}
                          onChange={() => onChange({ theme: value })}
                        />
                        <span
                          className={`cq-theme-sample cq-theme-sample--${value}`}
                        >
                          <Icon size={22} />
                          <i />
                          <i />
                          <i />
                        </span>
                        <strong>{title}</strong>
                        <span>{note}</span>
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="cq-inline-choice cq-density">
                    <legend>Information density</legend>
                    {[
                      ["comfortable", "Comfortable"],
                      ["compact", "Compact"],
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="density"
                          checked={draft.density === value}
                          onChange={() =>
                            onChange({
                              density: value as OnboardingDraft["density"],
                            })
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="cq-working-mode">
                    <legend>How much guidance would help?</legend>
                    {(
                      [
                        {
                          value: "guided",
                          label: "Guided",
                          description:
                            "Keep explanations and workflow shortcuts visible.",
                        },
                        {
                          value: "focused",
                          label: "Focused",
                          description:
                            "Keep the working view concise. Hide optional guidance.",
                        },
                      ] as const
                    ).map((mode) => (
                      <label key={mode.value}>
                        <input
                          type="radio"
                          name="workspaceMode"
                          checked={draft.workspaceMode === mode.value}
                          onChange={() =>
                            onChange({ workspaceMode: mode.value })
                          }
                        />
                        <span>
                          <strong>{mode.label}</strong>
                          <small>{mode.description}</small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}
              {step === 4 && (
                <div className="cq-step-body">
                  <p className="cq-lead">
                    {draft.experience === "new"
                      ? "Start with one area of your quality system. The rest of the application stays available through the work-area navigation."
                      : "Choose the operational area you want to open when setup is complete."}
                  </p>
                  <fieldset className="cq-path-options">
                    <legend className="sr-only">
                      Choose your starting point
                    </legend>
                    {(
                      [
                        {
                          value: "quality",
                          title: "Document control",
                          note: "Documents, reviews, and continuous improvement.",
                          Icon: ShieldCheck,
                        },
                        {
                          value: "production",
                          title: "Production records",
                          note: "Recipes, production records, and their next steps.",
                          Icon: Leaf,
                        },
                        {
                          value: "operations",
                          title: "Inventory & traceability",
                          note: "Materials, inventory, and the story of each lot.",
                          Icon: Waypoints,
                        },
                      ] as const
                    ).map(({ value, title, note, Icon }, index) => (
                      <label
                        key={value}
                        className={draft.focus === value ? "is-selected" : ""}
                      >
                        <input
                          type="radio"
                          name="focus"
                          checked={draft.focus === value}
                          onChange={() => onChange({ focus: value })}
                        />
                        <span className="cq-path-index">0{index + 1}</span>
                        <Icon size={25} />
                        <span>
                          <strong>{title}</strong>
                          <small>{note}</small>
                        </span>
                        <span className="cq-path-check">
                          {draft.focus === value ? (
                            <Check size={17} />
                          ) : (
                            <ChevronRight size={17} />
                          )}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="cq-microcopy">
                    This sets your starting point. It doesn't change your role
                    or permissions.
                  </p>
                </div>
              )}
              {step === 5 && (
                <div className="cq-step-body">
                  <p className="cq-lead">
                    Confirm the identity, facility, and preferences below.
                    Activating this setup opens your chosen workflow.
                  </p>
                  <dl className="cq-review">
                    <div>
                      <dt>Record identity</dt>
                      <dd>
                        {snapshot.user.fullName}
                        <small>
                          {snapshot.user.initials} · {snapshot.user.role}
                        </small>
                        <button
                          type="button"
                          aria-label="Review account identity"
                          onClick={() => void onNavigate(1)}
                        >
                          Review
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Licensed facility</dt>
                      <dd>
                        {snapshot.needsWorkspace
                          ? draft.facilityName || "A detail still to add"
                          : snapshot.facility?.name || "Waiting for access"}
                        <small>
                          {snapshot.needsWorkspace
                            ? draft.companyName
                            : snapshot.companyName}
                        </small>
                        <button
                          type="button"
                          aria-label="Review licensed facility"
                          onClick={() => void onNavigate(2)}
                        >
                          Review
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Working view</dt>
                      <dd>
                        {draft.theme === "light"
                          ? "Light"
                          : draft.theme === "dark"
                            ? "Dark"
                            : "System"}
                        <small>
                          {draft.density === "comfortable"
                            ? "Comfortable"
                            : "Compact"}
                        </small>
                        <button
                          type="button"
                          aria-label="Review display preferences"
                          onClick={() => void onNavigate(3)}
                        >
                          Review
                        </button>
                      </dd>
                    </div>
                  </dl>
                  <div className="cq-next-path">
                    <span className="cq-eyebrow">OPEN AFTER SETUP</span>
                    <h2>{selectedPath.title}</h2>
                    <p>{selectedPath.description}</p>
                  </div>
                  {snapshot.accessPending && (
                    <p className="cq-field-error">
                      Your progress is ready. Your administrator still needs to
                      assign your facility before you can enter.
                    </p>
                  )}
                </div>
              )}
              {error && (
                <div className="cq-save-error" role="alert">
                  <p>{error.message}</p>
                  <button
                    type="button"
                    className="cq-text-action"
                    onClick={error.conflict ? onReload : onRetry}
                  >
                    {error.conflict
                      ? "Load saved progress"
                      : "Try saving again"}{" "}
                    <RotateCcw size={14} />
                  </button>
                </div>
              )}
            </fieldset>
            <footer className="cq-onboarding-footer">
              <div>
                {step > 0 ? (
                  <button
                    type="button"
                    className="cq-text-action"
                    onClick={() => void onNavigate(step - 1)}
                    disabled={busy}
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                ) : (
                  <span className="cq-microcopy">
                    Approximately 3–5 minutes
                  </span>
                )}
              </div>
              <div className="cq-footer-actions">
                <button
                  type="button"
                  className="cq-text-action cq-save-later"
                  onClick={() => void onDefer()}
                  disabled={busy}
                >
                  {returning ? "Save and return" : "Save for later"}
                </button>
                <button
                  className="cq-action"
                  type="submit"
                  disabled={
                    busy ||
                    !!error?.conflict ||
                    (step === 5 && snapshot.accessPending)
                  }
                >
                  {busy
                    ? "Saving…"
                    : step === 5
                      ? returning
                        ? "Open workspace"
                        : "Activate workspace"
                      : step === 0
                        ? "Start setup"
                        : "Continue"}
                  <ArrowRight size={17} />
                </button>
              </div>
            </footer>
          </form>
        )}
        <div className="cq-bottom-note">
          <span className="cq-note-line" />
          <span>{NOTES[step]}</span>
          <span className="cq-page-counter">
            {String(step + 1).padStart(2, "0")} / 06
          </span>
        </div>
      </main>
      <aside className="cq-setup-record" aria-label="Setup record">
        <div className="cq-record-title">
          <span className="cq-eyebrow">CONFIGURATION RECORD</span>
          <span className="cq-record-state">
            {snapshot.completedAt ? "ACTIVE" : "DRAFT"}
          </span>
        </div>
        <dl>
          <div>
            <dt>ACCOUNT</dt>
            <dd>
              {snapshot.user.fullName}
              <small>
                {snapshot.user.initials} / {snapshot.user.role}
              </small>
            </dd>
          </div>
          <div>
            <dt>ORGANIZATION</dt>
            <dd>
              {snapshot.needsWorkspace
                ? draft.companyName || "Not entered"
                : snapshot.companyName || "Awaiting assignment"}
            </dd>
          </div>
          <div>
            <dt>OPERATING SITE</dt>
            <dd>
              {snapshot.needsWorkspace
                ? draft.facilityName || "Not entered"
                : snapshot.facility?.name || "Not assigned"}
            </dd>
          </div>
          <div>
            <dt>LICENCE REFERENCE</dt>
            <dd className="cq-record-mono">
              {snapshot.needsWorkspace
                ? draft.licenseNumber || "Pending"
                : snapshot.facility?.licenseNumber || "Pending"}
            </dd>
          </div>
        </dl>
        <div className="cq-record-guidance">
          <ShieldCheck size={20} />
          <h2>Access follows your role.</h2>
          <p>
            Your administrator manages permissions and facility membership.
            Setup cannot grant additional access.
          </p>
        </div>
        <div className="cq-record-footer">
          <span>PROGRESS</span>
          <strong>
            {String(step + 1).padStart(2, "0")}
            <small> / 06</small>
          </strong>
          <div>
            <i style={{ width: `${((step + 1) / 6) * 100}%` }} />
          </div>
        </div>
      </aside>
    </div>
  );
}
