import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiProfile,
  askAssistant,
  ChatMessage,
  Citizenship,
  classifyCitizenship,
  clearChatHistory,
  getChatHistory,
  getKbStatus,
  getProfileDetails,
  generatePlan,
  getProfile,
  getStopFeedback,
  loadSession,
  login,
  Plan,
  PlanStop,
  saveProfile,
  saveSession,
  warmUpModels,
  DOCUMENT_ACCEPT,
  deleteDocument,
  listDocuments,
  MAX_DOCUMENT_MB,
  UploadedDocument,
  uploadDocument,
  waitForDocuments,
} from "./api";


/** Map AI-generated stops onto the Task shape the timeline already renders. */
function planToTasks(stops: PlanStop[]): Task[] {
  return stops.map((s, i) => ({
    id: i + 1,
    phase: s.phase || "Your steps",
    title: s.title || `Step ${i + 1}`,
    description: s.why || "",
    deadline: s.deadline || "",
    time: s.time || "",
    source: s.sourceTitle || "",
    sourceUrl: s.sourceUrl || "",
    documents: Array.isArray(s.documents) ? s.documents : [],
    emailTo: undefined,
    personalisedBecause: s.personalisedBecause || "",
    formUrl: s.formUrl || "",
    formLabel: s.formLabel || "",
    formLang: s.formLang || "",
    pending: s.pending === true,
  }));
}

type Screen = "onboarding" | "loading" | "dashboard";

type Profile = {
  email: string;
  firstName: string;
  nationality: string;
  age: string;
  status: string;
  university: string;
  degree: string;
  canton: string;
  arrival: string;
  // Answers the AI uses to personalise the plan.
  stayLength: string;
  municipality: string;
  housingStatus: string;
  plansToWork: string;
  healthCoverage: string;
};

type Task = {
  id: number;
  phase: string;
  title: string;
  description: string;
  deadline: string;
  time: string;
  source: string;
  sourceUrl: string;
  documents: string[];
  emailTo?: string;
  /** True while the AI is still writing this stop's details. */
  pending?: boolean;
  /** Why this stop is in this student's plan. */
  personalisedBecause?: string;
  /** Official form/action page for this stop (resolved server-side from a curated list). */
  formUrl?: string;
  formLabel?: string;
  formLang?: string;
};

const initialProfile: Profile = {
  email: "",
  firstName: "",
  nationality: "",
  age: "",
  status: "Determined from citizenship",
  university: "Bern University of Applied Sciences",
  degree: "Exchange semester",
  canton: "Bern",
  arrival: "2026-08-24",
  stayLength: "One semester (about 4–6 months)",
  municipality: "City of Bern",
  housingStatus: "Still looking",
  plansToWork: "No",
  healthCoverage: "European Health Insurance Card (EHIC)",
};

const tasks: Task[] = [
  {
    id: 1,
    phase: "Before you arrive",
    title: "Apply for your student visa",
    description:
      "Submit your national visa D application to the Swiss representation in your country of residence.",
    deadline: "Start now",
    time: "6–12 weeks",
    source: "State Secretariat for Migration",
    sourceUrl: "https://www.sem.admin.ch/",
    documents: ["Admission letter", "Proof of funds", "Valid passport"],
    emailTo: "Swiss representation",
  },
  {
    id: 2,
    phase: "Before you arrive",
    title: "Secure accommodation",
    description:
      "Arrange a Bern address before arrival. You’ll need your rental agreement for local registration.",
    deadline: "Before 24 Aug",
    time: "2–4 weeks",
    source: "BFH International Office",
    sourceUrl: "https://www.bfh.ch/",
    documents: ["Admission letter", "Passport copy"],
    emailTo: "BFH Housing Office",
  },
  {
    id: 3,
    phase: "First week in Bern",
    title: "Register with your commune",
    description:
      "Visit your residents’ registration office within 14 days of arrival and before starting your studies.",
    deadline: "By 7 Sep",
    time: "45 min",
    source: "City of Bern",
    sourceUrl: "https://www.bern.ch/",
    documents: ["Passport", "Rental agreement", "Passport photo", "Admission letter"],
    emailTo: "Residents’ Registration Office",
  },
  {
    id: 4,
    phase: "First month",
    title: "Open a Swiss bank account",
    description:
      "Choose a student account for rent, health insurance, and everyday payments after registration.",
    deadline: "By 24 Sep",
    time: "30 min",
    source: "BFH Welcome Guide",
    sourceUrl: "https://www.bfh.ch/",
    documents: ["Passport", "Registration confirmation", "Student ID"],
  },
  {
    id: 5,
    phase: "First three months",
    title: "Arrange health insurance",
    description:
      "Take out Swiss basic insurance or request an exemption if your existing policy offers equivalent coverage.",
    deadline: "By 24 Nov",
    time: "1–2 hours",
    source: "Federal Office of Public Health",
    sourceUrl: "https://www.bag.admin.ch/",
    documents: ["Insurance policy", "Residence permit", "Confirmation of study"],
    emailTo: "Cantonal Health Insurance Office",
  },
  {
    id: 6,
    phase: "Settle in",
    title: "Get your student transport pass",
    description:
      "Compare the Libero network pass and the SBB Half Fare Travelcard for your regular journeys.",
    deadline: "When ready",
    time: "20 min",
    source: "SBB",
    sourceUrl: "https://www.sbb.ch/",
    documents: ["Passport", "Passport photo", "Student ID"],
  },
];

const onboardingCopy = [
  {
    eyebrow: "Your Swiss start",
    title: "Let’s build your path.",
    body: "No generic lists. We’ll ask a few questions and turn official Swiss guidance into a plan made for you.",
  },
  {
    eyebrow: "Step 1 of 3",
    title: "First, who are you?",
    body: "Your citizenship group and age affect which permit and insurance rules apply.",
  },
  {
    eyebrow: "Step 2 of 3",
    title: "Tell us about your studies.",
    body: "We’ll match your plan to your university, degree, canton, and local authorities.",
  },
  {
    eyebrow: "Step 3 of 3",
    title: "When do you arrive?",
    body: "Your deadlines will be calculated from this date. You can change it at any time.",
  },
];

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M3 10h13M11 5l5 5-5 5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="5" y="5" width="10" height="10" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SwissMark({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`swiss-mark ${dark ? "dark" : ""}`} aria-hidden="true">
      <i />
      <b />
    </span>
  );
}

function MatterhornOutline() {
  return (
    <svg
      aria-hidden="true"
      className="matterhorn-outline"
      viewBox="0 0 760 620"
      preserveAspectRatio="xMidYMax meet"
    >
      <path d="M28 570L116 526L174 470L232 436L276 364L320 324L350 252L374 218L396 128L423 57L450 166L476 228L503 260L530 336L574 388L608 462L656 503L733 552" />
      <path d="M174 470L260 474L320 412L350 252L388 308L423 57L450 166L428 246L476 228L456 326L530 336L496 400L608 462" />
      <path d="M320 412L372 390L407 332L456 326" />
      <path className="snow-line" d="M350 252L388 308L407 272L428 246L450 166" />
      <path className="ground-line" d="M10 570H214L242 558H508L548 570H750" />
      <g className="mountain-pixels">
        <rect x="91" y="510" width="8" height="8" />
        <rect x="551" y="420" width="8" height="8" />
        <rect x="620" y="494" width="8" height="8" />
        <rect x="243" y="420" width="8" height="8" />
      </g>
    </svg>
  );
}

function AppHeader({
  compact = false,
  onReset,
  onOpenProfile,
  initials = "",
}: {
  compact?: boolean;
  onReset?: () => void;
  onOpenProfile?: () => void;
  initials?: string;
}) {
  return (
    <header className={`app-header ${compact ? "compact" : ""}`}>
      <button className="brand" onClick={onReset} type="button" aria-label="Start over">
        <SwissMark dark />
        <span>HelvetiStart</span>
      </button>
      {compact && (
        <div className="header-actions">
          <button className="avatar" type="button" aria-label="Open my profile" onClick={onOpenProfile}>
            {initials || "Me"}
          </button>
        </div>
      )}
    </header>
  );
}

// Choices shared by onboarding and the "My profile" panel, so both always match.
const OPTIONS = {
  university: ["Bern University of Applied Sciences", "University of Bern", "Other institution"],
  degree: ["Bachelor’s degree", "Master’s degree", "Exchange semester", "Doctorate"],
  municipality: ["City of Bern", "Another municipality in the canton of Bern", "Not sure yet"],
  stayLength: [
    "Up to 3 months",
    "One semester (about 4–6 months)",
    "Two semesters (about 10–12 months)",
    "Longer than a year",
  ],
  housingStatus: ["Still looking", "Already arranged"],
  plansToWork: ["No", "Yes", "Not sure yet"],
  healthCoverage: [
    "European Health Insurance Card (EHIC)",
    "Private international insurance",
    "None / not sure",
  ],
} satisfies Partial<Record<keyof Profile, string[]>>;

const EHIC = "European Health Insurance Card (EHIC)";

/** **bold** inside a line; everything else stays plain text. */
function inlineMarks(text: string): React.ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) =>
      part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

/**
 * The assistant's light formatting: paragraphs, "- " bullets, "1. " numbered
 * lists and **bold**. It builds React elements only, never HTML, so nothing the
 * model writes can inject markup into the page.
 */
function RichText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inlineMarks(item)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    const item = bullet?.[1] ?? numbered?.[1];
    if (item !== undefined) {
      if (list && list.ordered !== Boolean(numbered)) flush();
      list ??= { ordered: Boolean(numbered), items: [] };
      list.items.push(item);
      continue;
    }
    flush();
    // Headings aren't asked for; if one slips through, show it as plain bold text.
    if (line) blocks.push(<p key={blocks.length}>{inlineMarks(line.replace(/^#+\s*/, ""))}</p>);
  }
  flush();
  return <div className="rich-text">{blocks}</div>;
}

/** "2026-10-30 11:49:05" or an ISO date -> "30 Oct 2026". */
function formatDay(value: string): string {
  const date = new Date(value.replace(" ", "T"));
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function Options({ field, exclude = [] }: { field: keyof typeof OPTIONS; exclude?: string[] }) {
  return (
    <>
      {OPTIONS[field]
        .filter((option) => !exclude.includes(option))
        .map((option) => (
          <option key={option}>{option}</option>
        ))}
    </>
  );
}

/**
 * Ask the server which citizenship group a nationality belongs to (the server
 * is the single source of truth), shortly after the student stops typing.
 */
function useCitizenship(nationality: string): Citizenship | null {
  const [result, setResult] = useState<Citizenship | null>(null);
  useEffect(() => {
    const value = nationality.trim();
    if (!value) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      classifyCitizenship(value)
        .then((r) => !cancelled && setResult(r))
        .catch(() => {
          // backend unreachable — the server re-checks on save anyway
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [nationality]);
  return result;
}

function Onboarding({
  profile,
  setProfile,
  onLogin,
  onComplete,
}: {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
  onLogin: (email: string) => Promise<void>;
  onComplete: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = onboardingCopy[step];
  const citizenship = useCitizenship(profile.nationality);
  const detectedCountry = citizenship?.country ?? null;

  function update(field: keyof Profile, value: string) {
    setProfile((current) => ({ ...current, [field]: value }));
  }

  // Keep the profile's citizenship group in sync with what the server detected.
  // The EHIC is only for EU/EFTA citizens, so a non-EU student can't keep it as
  // their answer (it's the default); they pick their actual cover instead.
  useEffect(() => {
    setProfile((current) => {
      const status = citizenship?.group ?? "Determined from citizenship";
      const nonEu = status === "Non-EU / EFTA";
      return {
        ...current,
        status,
        healthCoverage:
          nonEu && current.healthCoverage === EHIC ? "None / not sure" : current.healthCoverage,
      };
    });
  }, [citizenship, setProfile]);

  async function next(event: FormEvent) {
    event.preventDefault();
    setError(null);

    // Step 0 is the email sign-in: talk to the backend before advancing.
    if (step === 0) {
      setBusy(true);
      try {
        await onLogin(profile.email);
      } catch (err) {
        setError((err as Error).message);
        setBusy(false);
        return;
      }
      setBusy(false);
    }

    if (step < 3) {
      setStep((current) => current + 1);
    } else {
      setBusy(true);
      await onComplete();
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <AppHeader onReset={() => setStep(0)} />
      <div className="onboarding-grid">
        <section className="intro-panel">
          <MatterhornOutline />
          <div className="pixel-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p className="intro-copy">{copy.body}</p>
          </div>
          <div className="route-graphic" aria-hidden="true">
            <span className="route-line" />
            <span className="route-stop start" />
            <SwissMark />
            <span className="route-stop end" />
            <p>Home</p>
            <p>Bern</p>
          </div>
          <p className="fine-print">
            Grounded in official federal, cantonal, and university sources.
            <br />
            Private by design · The AI runs on this computer
          </p>
        </section>

        <section className="form-panel">
          <div className="progress-row">
            {onboardingCopy.map((_, index) => (
              <span key={index} className={index <= step ? "active" : ""} />
            ))}
          </div>

          <form onSubmit={next}>
            {step === 0 && (
              <div className="form-content">
                <div className="mini-mark">
                  <SwissMark dark />
                </div>
                <h2>Welcome to Switzerland.</h2>
                <p>Sign in with the email used for your university application.</p>
                <label>
                  Email address
                  <input
                    autoFocus
                    required
                    type="email"
                    placeholder="you@example.com"
                    value={profile.email}
                    onChange={(event) => update("email", event.target.value)}
                  />
                </label>
                {error && <p className="form-error">{error}</p>}
                <button className="primary-button" type="submit" disabled={busy}>
                  {busy ? "Signing in…" : "Continue"} <ArrowIcon />
                </button>
                <p className="terms">
                  By continuing, you agree to our privacy policy. Your answers are used only to
                  create this plan.
                </p>
              </div>
            )}

            {step === 1 && (
              <div className="form-content">
                <h2>A little about you</h2>
                <p>Only the details that change your relocation requirements.</p>
                <div className="two-columns">
                  <label>
                    First name
                    <input
                      autoFocus
                      required
                      placeholder="Alex"
                      value={profile.firstName}
                      onChange={(event) => update("firstName", event.target.value)}
                    />
                  </label>
                  <label>
                    Age
                    <input
                      required
                      min="16"
                      max="99"
                      type="number"
                      placeholder="24"
                      value={profile.age}
                      onChange={(event) => update("age", event.target.value)}
                    />
                  </label>
                </div>
                <label>
                  Citizenship
                  <input
                    required
                    placeholder="e.g. Croatia or German"
                    value={profile.nationality}
                    onChange={(event) => update("nationality", event.target.value)}
                  />
                </label>
                {profile.nationality.trim() && profile.status !== "Determined from citizenship" && (
                  <p className="citizenship-hint">
                    {detectedCountry ? `${detectedCountry} · ` : ""}
                    <strong>{profile.status}</strong>
                    {!detectedCountry &&
                      " — if you hold an EU/EFTA passport, check the spelling or type the country name."}
                  </p>
                )}
                <FormNavigation step={step} setStep={setStep} />
              </div>
            )}

            {step === 2 && (
              <div className="form-content">
                <h2>Your studies</h2>
                <p>This example is tailored to international students relocating to Bern.</p>
                <label>
                  University
                  <select
                    value={profile.university}
                    onChange={(event) => update("university", event.target.value)}
                  >
                    <Options field="university" />
                  </select>
                </label>
                <label>
                  Programme
                  <select
                    value={profile.degree}
                    onChange={(event) => update("degree", event.target.value)}
                  >
                    <Options field="degree" />
                  </select>
                </label>
                <label>
                  Canton
                  <select
                    value={profile.canton}
                    onChange={(event) => update("canton", event.target.value)}
                  >
                    <option>Bern</option>
                    <option disabled>Zürich — coming soon</option>
                    <option disabled>Vaud — coming soon</option>
                  </select>
                </label>
                <div className="two-columns">
                  <label>
                    Where will you live?
                    <select
                      value={profile.municipality}
                      onChange={(event) => update("municipality", event.target.value)}
                    >
                      <Options field="municipality" />
                    </select>
                  </label>
                  <label>
                    How long will you stay?
                    <select
                      value={profile.stayLength}
                      onChange={(event) => update("stayLength", event.target.value)}
                    >
                      <Options field="stayLength" />
                    </select>
                  </label>
                </div>
                <FormNavigation step={step} setStep={setStep} />
              </div>
            )}

            {step === 3 && (
              <div className="form-content">
                <h2>A few last details</h2>
                <p>These decide which steps you need and in what order.</p>
                <div className="two-columns">
                  <label>
                    Planned arrival date
                    <input
                      required
                      type="date"
                      value={profile.arrival}
                      onChange={(event) => update("arrival", event.target.value)}
                    />
                  </label>
                  <label>
                    Accommodation
                    <select
                      value={profile.housingStatus}
                      onChange={(event) => update("housingStatus", event.target.value)}
                    >
                      <Options field="housingStatus" />
                    </select>
                  </label>
                </div>
                <div className="two-columns">
                  <label>
                    Do you plan to work in Switzerland?
                    <select
                      value={profile.plansToWork}
                      onChange={(event) => update("plansToWork", event.target.value)}
                    >
                      <Options field="plansToWork" />
                    </select>
                  </label>
                  <label>
                    Health coverage from home
                    <select
                      value={profile.healthCoverage}
                      onChange={(event) => update("healthCoverage", event.target.value)}
                    >
                      <Options
                        field="healthCoverage"
                        exclude={profile.status === "Non-EU / EFTA" ? [EHIC] : []}
                      />
                    </select>
                  </label>
                </div>
                <div className="privacy-card">
                  <span className="privacy-pixel" aria-hidden="true" />
                  <div>
                    <strong>Your data stays yours</strong>
                    <p>
                      We don’t store documents or use your details to train AI. You can delete
                      your plan whenever you like.
                    </p>
                  </div>
                </div>
                <FormNavigation step={step} setStep={setStep} final />
              </div>
            )}
          </form>
        </section>
      </div>
    </main>
  );
}

function FormNavigation({
  step,
  setStep,
  final = false,
}: {
  step: number;
  setStep: React.Dispatch<React.SetStateAction<number>>;
  final?: boolean;
}) {
  return (
    <div className="form-navigation">
      <button className="back-button" type="button" onClick={() => setStep(step - 1)}>
        Back
      </button>
      <button className="primary-button" type="submit">
        {final ? "Create my plan" : "Continue"} <ArrowIcon />
      </button>
    </div>
  );
}

function LoadingScreen({ profile, plan }: { profile: Profile; plan: Plan | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => setElapsed((current) => current + 200), 200);
    return () => window.clearInterval(interval);
  }, []);

  // The plan's steps arrive within a second or two; the local AI then writes
  // each step's details. The steps are listed here as they are finished, and
  // App switches to the dashboard when the last one is done.
  const steps = plan?.stops ?? [];
  const written = steps.filter((step) => !step.pending).length;
  // Before the steps are known the bar eases forward; after that it shows
  // real progress (a step counts once its details are written).
  const pct =
    steps.length > 0
      ? Math.max(8, Math.round((100 * written) / steps.length))
      : Math.min(20, Math.round(20 * (1 - Math.exp(-elapsed / 3000))));
  const status =
    steps.length === 0
      ? elapsed < 1500
        ? "Matching your profile to Swiss rules"
        : `Checking ${profile.canton} forms, deadlines and dependencies`
      : written < steps.length
        ? `Reading the official sources for step ${written + 1} of ${steps.length}`
        : "Putting your steps in order";

  return (
    <main className="loading-screen">
      <div className="loading-brand">
        <SwissMark />
        <span>HelvetiStart</span>
      </div>
      <section className="loading-content">
        <div className="loader-map" aria-hidden="true">
          <div className="map-shape">
            <span className="scan-line" />
            <span className="map-dot one" />
            <span className="map-dot two" />
            <span className="map-dot three" />
          </div>
        </div>
        <p className="eyebrow">Your plan is taking shape</p>
        <h1>AI is configuring your path.</h1>
        <p className="loading-status">{status}</p>
        <div className="loading-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="loading-meta">
          <span>{pct}%</span>
          <span>Runs privately on your device · under a minute</span>
        </div>
        {steps.length > 0 && (
          <ol className="loading-steps" aria-label="Your steps">
            {steps.map((step, index) => (
              <li key={index} className={step.pending ? "pending" : "done"}>
                <span className="loading-step-mark" aria-hidden="true">
                  {step.pending ? "" : "✓"}
                </span>
                {step.title}
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="source-note">Local AI · Official Swiss sources only</p>
    </main>
  );
}

/**
 * The student's uploaded documents. While any is still being read by the local
 * AI, the list is refreshed every few seconds. `onReady` is called once for each
 * document that finishes reading during this visit.
 */
function useDocuments(userId: number | null, onReady: (document: UploadedDocument) => void) {
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [uploadError, setUploadError] = useState("");
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const statuses = useRef(new Map<number, UploadedDocument["status"]>());

  const refresh = async () => {
    if (userId == null) return;
    const next = await listDocuments(userId).catch(() => null);
    if (!next) return;
    for (const document of next) {
      if (statuses.current.get(document.id) === "processing" && document.status !== "processing") {
        onReadyRef.current(document);
      }
      statuses.current.set(document.id, document.status);
    }
    setDocuments(next);
  };

  useEffect(() => {
    statuses.current.clear();
    setDocuments([]);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const processing = documents.some((document) => document.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, userId]);

  async function upload(files: FileList | File[]): Promise<UploadedDocument[]> {
    if (userId == null) {
      setUploadError("Sign in to upload documents.");
      return [];
    }
    setUploadError("");
    const added: UploadedDocument[] = [];
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const document = await uploadDocument(userId, file);
        statuses.current.set(document.id, document.status);
        added.push(document);
        setDocuments((current) => [document, ...current]);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    setUploadError(errors.join(" "));
    return added;
  }

  async function remove(documentId: number) {
    if (userId == null) return;
    setDocuments((current) => current.filter((document) => document.id !== documentId));
    statuses.current.delete(documentId);
    await deleteDocument(userId, documentId).catch(() => refresh());
  }

  return { documents, upload, remove, uploadError, processing };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Drop zone + file picker for documents. */
function DocumentDropzone({
  onFiles,
  disabled,
}: {
  onFiles: (files: FileList) => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`document-dropzone ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled && event.dataTransfer.files.length) onFiles(event.dataTransfer.files);
      }}
    >
      <span className="nav-lines" aria-hidden="true" />
      <p>
        <strong>Drop files here</strong> or{" "}
        <button type="button" disabled={disabled} onClick={() => input.current?.click()}>
          choose files
        </button>
      </p>
      <small>
        PDF, photo (JPG, PNG) or text file, up to {MAX_DOCUMENT_MB} MB. For a paper letter, a phone
        photo works.
      </small>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={DOCUMENT_ACCEPT}
        onChange={(event) => {
          if (event.target.files?.length) onFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/** One uploaded document: what the AI understood from it. */
function DocumentCard({
  document,
  onAsk,
  onDelete,
}: {
  document: UploadedDocument;
  onAsk: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={`uploaded-document ${document.status}`}>
      <div className="uploaded-document-head">
        <div>
          <strong>{document.filename}</strong>
          <span>
            {document.status === "ready" && document.documentType
              ? `${document.documentType} · `
              : ""}
            {formatSize(document.size)}
          </span>
        </div>
        <span className={`document-status ${document.status}`}>
          {document.status === "processing"
            ? "Reading…"
            : document.status === "ready"
              ? "Understood"
              : "Couldn't read"}
        </span>
      </div>
      {document.status === "processing" && (
        <p className="document-note">
          The AI is reading this on your computer. Typed PDFs take seconds; photos and scans
          can take a few minutes.
        </p>
      )}
      {document.status === "failed" && <p className="document-note error">{document.error}</p>}
      {document.status === "ready" && (
        <>
          {document.summary && <p className="document-summary">{document.summary}</p>}
          {document.keyDetails.length > 0 && (
            <dl className="document-details">
              {document.keyDetails.map((detail, index) => (
                <div key={index}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      <div className="document-actions">
        {document.status === "ready" && (
          <button type="button" onClick={onAsk}>
            Ask about it
          </button>
        )}
        <button type="button" onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

function Dashboard({
  profile,
  plan,
  userId,
  onReset,
  onSaveProfile,
  onRebuildPlan,
}: {
  profile: Profile;
  plan: Plan | null;
  userId: number | null;
  onReset: () => void;
  onSaveProfile: (draft: Profile) => Promise<void>;
  onRebuildPlan: () => void;
}) {
  // Use the AI-generated stops when available; otherwise fall back to the
  // built-in starter list so the dashboard always renders something.
  const stops = useMemo<Task[]>(
    () => (plan && plan.stops.length > 0 ? planToTasks(plan.stops) : tasks),
    [plan],
  );

  const [completed, setCompleted] = useState<number[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task>(stops[0]);
  const [expandedTask, setExpandedTask] = useState<number | null>(null);
  // The stop the mouse opened by hovering. Only that one closes when the mouse
  // leaves; a stop opened by a tap or click stays open until it's tapped again
  // (otherwise layout shifts under a resting cursor would close it at once).
  const hoverOpened = useRef<number | null>(null);
  // Hover-to-open only where there is a real hovering pointer (mouse, trackpad).
  // Phones and tablets use taps only.
  const canHover = useMemo(
    () => window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true,
    [],
  );
  const [showEmail, setShowEmail] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);

  const [showDocuments, setShowDocuments] = useState(false);

  // One drawer at a time; "My path" closes them all.
  function openDrawer(drawer: "assistant" | "profile" | "documents" | null) {
    setShowAssistant(drawer === "assistant");
    setShowProfile(drawer === "profile");
    setShowDocuments(drawer === "documents");
  }
  const openProfile = () => openDrawer("profile");
  const openAssistant = () => openDrawer("assistant");
  const activeNav = showAssistant
    ? "assistant"
    : showProfile
      ? "profile"
      : showDocuments
        ? "documents"
        : "path";

  // When the knowledge base was last checked against the official sources.
  const [sourcesChecked, setSourcesChecked] = useState<string | null>(null);
  useEffect(() => {
    getKbStatus()
      .then((status) => setSourcesChecked(status.lastChecked))
      .catch(() => setSourcesChecked(null));
  }, []);

  // Short AI feedback shown inside a stop once it's marked complete.
  const [feedback, setFeedback] = useState<Record<number, { loading: boolean; text?: string }>>({});

  // "Ask HelvetiStart" chat state. A signed-in student's conversation is saved on
  // the server, so it is loaded back when they return.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  // Lets the student stop an answer that is still being written.
  const chatStop = useRef<AbortController | null>(null);

  useEffect(() => {
    if (userId == null) return;
    getChatHistory(userId)
      .then(setMessages)
      .catch(() => {
        // backend unreachable — start with an empty conversation
      });
  }, [userId]);

  async function clearChat() {
    if (userId != null) await clearChatHistory(userId).catch(() => {});
    setMessages([]);
  }

  // Uploaded documents. One attached in the chat is uploaded at once, so the
  // local AI reads it while the student is still typing. It waits in the
  // composer and is sent together with the text, as one message.
  const [attachedIds, setAttachedIds] = useState<number[]>([]);
  const [attaching, setAttaching] = useState(false);
  // What the assistant is doing for the message just sent.
  const [chatStage, setChatStage] = useState<"reading" | "answering">("answering");
  const chatFileInput = useRef<HTMLInputElement>(null);
  const {
    documents: uploads,
    upload,
    remove: removeUpload,
    uploadError,
  } = useDocuments(userId, () => {});
  const attachedDocs = uploads.filter((document) => attachedIds.includes(document.id));

  async function attachInChat(files: FileList) {
    setAttaching(true);
    const added = await upload(files);
    setAttaching(false);
    setAttachedIds((current) => [...current, ...added.map((document) => document.id)]);
  }

  // What a document is, from what the AI worked out while reading it (no new
  // model call): the reply when a document is sent without a question.
  const describeDocument = (document: UploadedDocument) =>
    [
      `I've read **${document.filename}**${document.documentType ? ` (${document.documentType.toLowerCase()})` : ""}.`,
      document.summary,
      ...document.keyDetails.slice(0, 5).map((detail) => `- ${detail.label}: **${detail.value}**`),
      "Ask me anything about it, for example what you need to do next.",
    ]
      .filter(Boolean)
      .join("\n");

  function askAboutDocument(document: UploadedDocument) {
    openDrawer("assistant");
    sendChat("What does this document say, and is there anything I need to do because of it?", [
      document.id,
    ]);
  }

  const firstName = profile.firstName.trim();
  const progress = Math.round((completed.length / stops.length) * 100);

  // Derive the arrival strip from the known profile info.
  const arrivalDate = profile.arrival ? new Date(profile.arrival) : null;
  const hasArrival = arrivalDate !== null && !Number.isNaN(arrivalDate.getTime());
  const arrivalLabel = hasArrival
    ? arrivalDate!
        .toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
        .toUpperCase()
    : "—";
  const daysToGo = hasArrival
    ? Math.ceil((arrivalDate!.getTime() - Date.now()) / 86_400_000)
    : null;
  const arrivalCountdown =
    daysToGo === null
      ? ""
      : daysToGo > 1
        ? `${daysToGo} days to go`
        : daysToGo === 1
          ? "Tomorrow"
          : daysToGo === 0
            ? "Today"
            : "Arrived";
  const arrivalText = hasArrival
    ? arrivalDate!.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "";

  // The email draft, built from the student's own answers.
  const emailParagraphs = [
    "Dear Sir or Madam,",
    [
      firstName ? `My name is ${firstName} and I am` : "I am",
      `an incoming ${profile.degree.toLowerCase()} student at ${profile.university}.`,
      arrivalText && `I plan to arrive in Bern on ${arrivalText}.`,
    ]
      .filter(Boolean)
      .join(" "),
    `I'm writing to confirm the required documents and next steps for ${selectedTask.title.toLowerCase()}. Could you please let me know if I need to book an appointment in advance?`,
    `Kind regards,${firstName ? `\n${firstName}` : ""}`,
  ];

  // Every document the stops ask for, with the stops that need it.
  const documentList = useMemo(() => {
    const byDocument = new Map<string, Task[]>();
    for (const task of stops) {
      for (const document of task.documents) {
        byDocument.set(document, [...(byDocument.get(document) ?? []), task]);
      }
    }
    return [...byDocument.entries()];
  }, [stops]);

  // The first stop in plan order that isn't done yet: what to do next.
  const nextStop = stops.find((task) => !completed.includes(task.id));

  const groupedTasks = useMemo(
    () =>
      stops.reduce<Record<string, Task[]>>((groups, task) => {
        groups[task.phase] = [...(groups[task.phase] || []), task];
        return groups;
      }, {}),
    [stops],
  );

  // Mark a stop complete/incomplete. On completion, ask the local AI for a
  // short note about what it unlocks and what to focus on next.
  async function toggleTask(stop: Task) {
    const id = stop.id;
    const willComplete = !completed.includes(id);
    setCompleted((current) =>
      current.includes(id) ? current.filter((taskId) => taskId !== id) : [...current, id],
    );

    if (!willComplete) {
      setFeedback((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }

    setFeedback((current) => ({ ...current, [id]: { loading: true } }));
    try {
      const remaining = stops
        .filter((t) => t.id !== id && !completed.includes(t.id))
        .map((t) => t.title);
      const text = await getStopFeedback(profile, stop.title, remaining);
      setFeedback((current) => ({ ...current, [id]: { loading: false, text } }));
    } catch {
      setFeedback((current) => ({ ...current, [id]: { loading: false, text: "" } }));
    }
  }

  // Send a question to the local AI assistant, together with any documents
  // attached to it. If one is still being read, the question waits for it, so
  // there is one answer that covers both.
  async function sendChat(text: string, withDocuments: number[] = attachedIds) {
    const question = text.trim();
    if ((!question && withDocuments.length === 0) || chatBusy) return;
    setChatInput("");
    setAttachedIds([]);
    // Error replies shown in the chat aren't part of the conversation.
    const history = messages.filter((m) => (m.role === "user" && m.text) || m.sources);
    const attachments = uploads
      .filter((document) => withDocuments.includes(document.id))
      .map((document) => document.filename);
    setMessages((current) => [...current, { role: "user", text: question, attachments }]);
    setChatBusy(true);
    const stop = new AbortController();
    chatStop.current = stop;
    try {
      let read: UploadedDocument[] = [];
      if (withDocuments.length > 0 && userId != null) {
        setChatStage("reading");
        read = await waitForDocuments(userId, withDocuments, stop.signal);
      }
      setChatStage("answering");
      const ready = read.filter((document) => document.status === "ready");
      const unreadable = read
        .filter((document) => document.status === "failed")
        .map((document) => `I couldn't read **${document.filename}**. ${document.error ?? ""}`);
      if (!question) {
        const text = [...ready.map(describeDocument), ...unreadable].join("\n\n");
        setMessages((current) => [...current, { role: "ai", text }]);
        return;
      }
      const { answer, sources } = await askAssistant(
        profile,
        question,
        userId,
        history,
        stop.signal,
        ready.map((document) => document.id),
      );
      setMessages((current) => [
        ...current,
        { role: "ai", text: [...unreadable, answer].join("\n\n"), sources },
      ]);
    } catch (err) {
      if (stop.signal.aborted) {
        // Stopped by the student: take the message back out of the conversation
        // and return it to the composer, ready to edit or resend.
        setMessages((current) => {
          const last = current[current.length - 1];
          return last?.role === "user" && last.text === question ? current.slice(0, -1) : current;
        });
        setChatInput(question);
        setAttachedIds(withDocuments);
      } else {
        setMessages((current) => [...current, { role: "ai", text: (err as Error).message }]);
      }
    } finally {
      chatStop.current = null;
      setChatBusy(false);
    }
  }

  function stopChat() {
    chatStop.current?.abort();
  }

  return (
    <main className="dashboard-shell">
      <AppHeader
        compact
        onReset={onReset}
        onOpenProfile={openProfile}
        initials={initialsOf(profile.firstName)}
      />
      <div className="dashboard-layout">
        <aside className="sidebar">
          <nav>
            {(
              [
                ["path", "My path", "nav-pixel", () => openDrawer(null)],
                ["assistant", "Ask assistant", "nav-pixel outline", openAssistant],
                ["profile", "My profile", "nav-pixel outline", openProfile],
                ["documents", "Documents", "nav-lines", () => openDrawer("documents")],
              ] as const
            ).map(([id, label, icon, onClick]) => (
              <button
                key={id}
                className={`nav-item ${activeNav === id ? "active" : ""}`}
                type="button"
                onClick={onClick}
              >
                <span className={icon} /> {label}
              </button>
            ))}
          </nav>
          <div className="sidebar-place">
            <p>Moving to</p>
            <strong>{profile.canton}</strong>
            <span>{profile.university}</span>
          </div>
          <div className="sidebar-bottom">
            <p>Sources last checked</p>
            <strong>{sourcesChecked ? formatDay(sourcesChecked) : "—"}</strong>
            <details className="verify-info">
              <summary>How we verify information</summary>
              <p>
                Answers come only from official federal, Canton of Bern, City of Bern and BFH pages,
                fetched from an approved list of sites. Which steps you get, and which forms, is
                decided by fixed rules; the AI only explains them. Any figure the AI writes must
                appear in the sources, and pages are re-checked so changes get noticed. Always
                confirm on the linked official source.
              </p>
            </details>
          </div>
        </aside>

        <section className="dashboard-main">
          <div className="dashboard-title">
            <div>
              <p className="eyebrow">Personal relocation path</p>
              <h1>Grüezi{firstName ? `, ${firstName}` : ""}.</h1>
              <p>Here’s your path to a smooth start in Bern.</p>
            </div>
            <button className="assistant-button" type="button" onClick={openAssistant}>
              <span className="assistant-chat-icon" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Ask HelvetiStart
            </button>
          </div>

          <div className="overview-strip">
            <div className="strip-progress">
              <div
                className="progress-ring"
                style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}
              >
                <span>{progress}%</span>
              </div>
              <div>
                <p>Your progress</p>
                <strong>
                  {completed.length} of {stops.length} stops complete
                </strong>
              </div>
            </div>
            <div className="strip-divider" />
            <div className="strip-date">
              <p>Arrival in {profile.canton || "Bern"}</p>
              <strong>{arrivalLabel}</strong>
              {arrivalCountdown && <span>{arrivalCountdown}</span>}
            </div>
            <p className="strip-hint">Hover or tap a stop to see what you need</p>
          </div>

          <section className="timeline train-timeline">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Your route</p>
                <h2>{nextStop ? `Next stop: ${nextStop.title}` : "All stops complete"}</h2>
              </div>
              <span>Personalised for {profile.status}</span>
            </div>
            {plan?.note && (
              <div className="plan-note">
                <strong>{plan.unsupported ? "Not available yet" : "No personalised plan"}</strong>
                <p>{plan.note} Below is a general overview in the meantime.</p>
              </div>
            )}
            <div className="train-route">
              {Object.entries(groupedTasks).map(([phase, phaseTasks]) => (
                <div className="timeline-phase" key={phase}>
                  <p className="phase-label">{phase}</p>
                  {phaseTasks.map((task) => {
                    const isDone = completed.includes(task.id);
                    const isExpanded = expandedTask === task.id;
                    return (
                      <article
                        className={`task-row ${isExpanded ? "expanded" : ""} ${isDone ? "done" : ""}`}
                        key={task.id}
                        onClick={() => {
                          hoverOpened.current = null;
                          setSelectedTask(task);
                          setExpandedTask((current) => (current === task.id ? null : task.id));
                        }}
                        // Hover opens a stop only for a real mouse: on touch screens a
                        // tap fires "enter" and then the click, which closed it again.
                        onPointerEnter={(event) => {
                          if (!canHover || event.pointerType !== "mouse") return;
                          hoverOpened.current = task.id;
                          setSelectedTask(task);
                          setExpandedTask(task.id);
                        }}
                        onPointerLeave={(event) => {
                          if (event.pointerType !== "mouse" || hoverOpened.current !== task.id) return;
                          hoverOpened.current = null;
                          setExpandedTask((current) => (current === task.id ? null : current));
                        }}
                      >
                        <div className="station-column" aria-hidden="true">
                          <span className="rail" />
                          <span className="station">{isDone && "✓"}</span>
                        </div>
                        <div className="task-copy">
                          <div className="task-summary">
                            <div>
                              <span className="stop-number">Stop {task.id}</span>
                              <h3>{task.title}</h3>
                            </div>
                            <div className="task-meta">
                              <span>{task.deadline}</span>
                              <i>{task.time}</i>
                            </div>
                          </div>
                          <div className="task-expand" aria-hidden={!isExpanded}>
                            <div className="task-expand-inner">
                              <p>{task.description}</p>
                              {task.personalisedBecause && (
                                <p className="personalised-because">
                                  <span>For you</span>
                                  {task.personalisedBecause}
                                </p>
                              )}
                              <div className="expanded-details">
                                <div>
                                  {task.documents.length > 0 && (
                                    <>
                                      <span>Bring with you</span>
                                      <ul>
                                        {task.documents.map((document) => (
                                          <li key={document}>{document}</li>
                                        ))}
                                      </ul>
                                    </>
                                  )}
                                </div>
                                <div className="expanded-actions">
                                  {task.sourceUrl ? (
                                    <a
                                      href={task.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={task.source}
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      Official source ↗
                                    </a>
                                  ) : (
                                    task.source && <span className="guidance-tag">Coordinator guidance</span>
                                  )}
                                  {task.formUrl && (
                                    <a
                                      className="form-button"
                                      href={task.formUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      {task.formLabel || "Open the form"} ↗
                                      {task.formLang === "de" && <small>in German</small>}
                                    </a>
                                  )}
                                  {task.emailTo && (
                                    <button
                                      className="outline-button"
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setSelectedTask(task);
                                        setShowEmail(true);
                                      }}
                                    >
                                      Draft an email
                                    </button>
                                  )}
                                  <button
                                    className={`primary-button ${isDone ? "completed" : ""}`}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggleTask(task);
                                    }}
                                  >
                                    {isDone ? "Completed" : "Mark complete"}
                                  </button>
                                </div>
                              </div>
                              {feedback[task.id] && (
                                <div
                                  className={`stop-feedback ${
                                    feedback[task.id].loading ? "loading" : ""
                                  }`}
                                >
                                  <span className="feedback-spark" aria-hidden="true" />
                                  <p>
                                    {feedback[task.id].loading
                                      ? "HelvetiStart is updating your path…"
                                      : feedback[task.id].text || "Marked complete."}
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        <span className="expand-symbol" aria-hidden="true">
                          {isExpanded ? "−" : "+"}
                        </span>
                      </article>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="timeline-disclaimer">
              Guidance, not legal advice. Critical details link directly to the responsible
              authority.
            </p>
          </section>
        </section>
      </div>

      {showEmail && (
        <div className="modal-backdrop" onMouseDown={() => setShowEmail(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setShowEmail(false)}>
              Close
            </button>
            <p className="eyebrow">AI email draft</p>
            <h2>Ready to send</h2>
            <p className="modal-subtitle">
              Drafted for the {selectedTask.emailTo}. Review the details before sending.
            </p>
            <div className="email-fields">
              <p>
                <span>Subject</span>
                Question about {selectedTask.title.toLowerCase()}
              </p>
              <div className="email-body">
                {emailParagraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="back-button" type="button" onClick={() => setShowEmail(false)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={async () => {
                  const draft = `Subject: Question about ${selectedTask.title.toLowerCase()}\n\n${emailParagraphs.join("\n\n")}`;
                  await navigator.clipboard?.writeText(draft);
                  setEmailCopied(true);
                  window.setTimeout(() => setEmailCopied(false), 2000);
                }}
              >
                {emailCopied ? "Copied to clipboard" : "Copy email"}
              </button>
            </div>
          </section>
        </div>
      )}

      {showAssistant && (
        <div className="assistant-drawer">
          <div className="drawer-heading">
            <div>
              <p className="eyebrow">Official sources only</p>
              <h2>Ask HelvetiStart</h2>
            </div>
            <button type="button" onClick={() => setShowAssistant(false)}>
              Close
            </button>
          </div>
          <div className="assistant-thread">
            <div className="assistant-message">
              <SwissMark dark />
              <p>
                Hi{firstName ? ` ${firstName}` : ""}. Ask me anything about your move. I only answer
                from official Swiss sources and the documents you share with me, and nothing goes to
                an outside AI service. Use the paperclip to share a letter, contract or policy.
              </p>
            </div>
            {messages.map((message, index) => (
              <div key={index} className={`chat-msg ${message.role}`}>
                {message.role === "ai" && <SwissMark dark />}
                <div className="chat-bubble">
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="chat-bubble-files">
                      {message.attachments.map((filename) => (
                        <span key={filename}>
                          <PaperclipIcon />
                          {filename}
                        </span>
                      ))}
                    </div>
                  )}
                  {message.role === "ai" ? (
                    <RichText text={message.text} />
                  ) : (
                    message.text && <p>{message.text}</p>
                  )}
                  {message.sources && message.sources.length > 0 && (
                    <details className="chat-sources-toggle">
                      <summary>Sources ({message.sources.length})</summary>
                      <div className="chat-sources">
                        {message.sources.map((source) => {
                          const label = `[${(source.refs ?? [source.n]).join(", ")}] ${source.title}`;
                          return source.url ? (
                            <a key={source.n} href={source.url} target="_blank" rel="noreferrer">
                              {label} ↗
                            </a>
                          ) : (
                            <span key={source.n}>{label}</span>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {chatBusy && (
              <div className="chat-msg ai">
                <SwissMark dark />
                <div className="chat-bubble">
                  <p className="chat-thinking">
                    {chatStage === "reading"
                      ? "Reading your document… (runs locally; press stop to cancel)"
                      : "Checking official sources… (runs locally, ~a minute; press stop to cancel)"}
                  </p>
                </div>
              </div>
            )}
          </div>
          {messages.length === 0 && !chatBusy && (
            <div className="suggestions">
              <button type="button" onClick={() => sendChat("Can I work while studying?")}>
                Can I work while studying?
              </button>
              <button type="button" onClick={() => sendChat("Which insurance do I need?")}>
                Which insurance do I need?
              </button>
              <button type="button" onClick={() => sendChat("How do I register with my commune?")}>
                How do I register with my commune?
              </button>
            </div>
          )}
          {messages.length > 0 && !chatBusy && (
            <button className="chat-clear" type="button" onClick={clearChat}>
              Clear chat
            </button>
          )}
          {(attachedDocs.length > 0 || attaching || uploadError) && (
            <div className="chat-attachments">
              {attachedDocs.map((document) => (
                <span
                  key={document.id}
                  className={`chat-attachment ${document.status === "processing" ? "reading" : ""}`}
                >
                  {document.filename}
                  <em>
                    {document.status === "processing"
                      ? "reading…"
                      : document.status === "ready"
                        ? "read"
                        : "couldn't read"}
                  </em>
                  <button
                    type="button"
                    aria-label={`Remove ${document.filename}`}
                    title="Remove from this message"
                    onClick={() =>
                      setAttachedIds((current) => current.filter((id) => id !== document.id))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              {attaching && <span className="chat-attachment reading">Uploading…</span>}
              {uploadError && <span className="chat-attachment error">{uploadError}</span>}
            </div>
          )}
          <form
            className="assistant-input with-attach"
            onSubmit={(event) => {
              event.preventDefault();
              sendChat(chatInput);
            }}
          >
            <button
              type="button"
              className="attach-button"
              aria-label="Share a document"
              title={userId == null ? "Sign in to share documents" : "Share a document"}
              disabled={userId == null}
              onClick={() => chatFileInput.current?.click()}
            >
              <PaperclipIcon />
            </button>
            <input
              ref={chatFileInput}
              type="file"
              multiple
              hidden
              accept={DOCUMENT_ACCEPT}
              onChange={(event) => {
                if (event.target.files?.length) attachInChat(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              aria-label="Ask a question"
              placeholder="Ask about your move..."
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              disabled={chatBusy}
            />
            {chatBusy ? (
              // The keys make these two separate elements. As one reused element,
              // a click on Stop turned it into the submit button mid-click and
              // sent the question again.
              <button key="stop" type="button" aria-label="Stop the answer" title="Stop" onClick={stopChat}>
                <StopIcon />
              </button>
            ) : (
              <button
                key="send"
                type="submit"
                aria-label="Send question"
                disabled={(!chatInput.trim() && attachedIds.length === 0) || attaching}
              >
                <ArrowIcon />
              </button>
            )}
          </form>
        </div>
      )}

      {showDocuments && (
        <div className="assistant-drawer documents-drawer">
          <div className="drawer-heading">
            <div>
              <p className="eyebrow">Read by your local AI</p>
              <h2>Documents</h2>
            </div>
            <button type="button" onClick={() => openDrawer(null)}>
              Close
            </button>
          </div>
          <section className="documents-section">
            <h3>Your files</h3>
            <p className="profile-intro">
              Upload letters, contracts or policies and HelvetiStart's AI reads them, on this computer
              only, so it can answer questions about them. Files stay in your local HelvetiStart account
              until you delete them.
            </p>
            <DocumentDropzone onFiles={(files) => upload(files)} disabled={userId == null} />
            {userId == null && (
              <p className="document-note error">Sign in to upload documents.</p>
            )}
            {uploadError && <p className="document-note error">{uploadError}</p>}
            {uploads.length > 0 && (
              <ul className="uploaded-documents">
                {uploads.map((document) => (
                  <DocumentCard
                    key={document.id}
                    document={document}
                    onAsk={() => askAboutDocument(document)}
                    onDelete={() => removeUpload(document.id)}
                  />
                ))}
              </ul>
            )}
          </section>
          <h3 className="documents-subheading">What your stops ask for</h3>
          <p className="profile-intro">Everything your stops ask you to have ready.</p>
          {documentList.length === 0 ? (
            <p className="profile-intro">None of your stops list documents yet.</p>
          ) : (
            <ul className="document-list">
              {documentList.map(([document, tasks]) => (
                <li key={document}>
                  <strong>{document}</strong>
                  <span>
                    {tasks.map((task) => `Stop ${task.id}: ${task.title}`).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showProfile && (
        <ProfilePanel
          profile={profile}
          userId={userId}
          onClose={() => setShowProfile(false)}
          onSave={onSaveProfile}
          onRebuildPlan={onRebuildPlan}
        />
      )}
    </main>
  );
}

function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

/**
 * "My profile": shows what HelvetiStart has stored for the student (loaded from the
 * server, not just this browser), how their citizenship was classified, and
 * lets them correct it and rebuild their plan.
 */
function ProfilePanel({
  profile,
  userId,
  onClose,
  onSave,
  onRebuildPlan,
}: {
  profile: Profile;
  userId: number | null;
  onClose: () => void;
  onSave: (draft: Profile) => Promise<void>;
  onRebuildPlan: () => void;
}) {
  const [draft, setDraft] = useState<Profile>(profile);
  const [stored, setStored] = useState<"loading" | "ok" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<"saved" | "error" | null>(null);
  const citizenship = useCitizenship(draft.nationality);

  useEffect(() => {
    if (userId == null) {
      setStored("unavailable");
      return;
    }
    getProfileDetails(userId)
      .then((details) => {
        if (details) setDraft((current) => mergeProfile(current, details.profile));
        setStored(details ? "ok" : "unavailable");
      })
      .catch(() => setStored("unavailable"));
  }, [userId]);

  // The citizenship group is derived on the server, so it doesn't count as an edit.
  const dirty = (Object.keys(draft) as (keyof Profile)[]).some(
    (key) => key !== "status" && draft[key] !== profile[key],
  );

  function set(field: keyof Profile, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaveResult(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(draft);
      setSaveResult("saved");
    } catch {
      setSaveResult("error");
    } finally {
      setSaving(false);
    }
  }

  const select = (field: keyof typeof OPTIONS) => (
    <select value={draft[field]} onChange={(event) => set(field, event.target.value)}>
      <Options field={field} />
    </select>
  );

  return (
    <div className="assistant-drawer profile-drawer">
      <div className="drawer-heading">
        <div>
          <p className="eyebrow">What HelvetiStart knows about you</p>
          <h2>My profile</h2>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <p className="profile-intro">
        {stored === "ok"
          ? "These are the details saved for your account. Only the AI running on this device uses them."
          : stored === "loading"
            ? "Loading your saved details…"
            : "Couldn't load your saved details — showing what this browser remembers."}
      </p>

      <form className="profile-form" onSubmit={save}>
        <div className="profile-citizenship">
          <span>Citizenship group</span>
          <strong>{citizenship?.group ?? draft.status}</strong>
          {citizenship?.country && <em>Detected country: {citizenship.country}</em>}
        </div>

        <label>
          Email
          <input value={draft.email} disabled />
        </label>
        <div className="two-columns">
          <label>
            First name
            <input value={draft.firstName} onChange={(event) => set("firstName", event.target.value)} />
          </label>
          <label>
            Age
            <input
              type="number"
              min="16"
              max="99"
              value={draft.age}
              onChange={(event) => set("age", event.target.value)}
            />
          </label>
        </div>
        <label>
          Citizenship
          <input value={draft.nationality} onChange={(event) => set("nationality", event.target.value)} />
        </label>
        <label>
          University
          {select("university")}
        </label>
        <label>
          Programme
          {select("degree")}
        </label>
        <div className="two-columns">
          <label>
            Where will you live?
            {select("municipality")}
          </label>
          <label>
            How long will you stay?
            {select("stayLength")}
          </label>
        </div>
        <div className="two-columns">
          <label>
            Planned arrival
            <input
              type="date"
              value={draft.arrival}
              onChange={(event) => set("arrival", event.target.value)}
            />
          </label>
          <label>
            Accommodation
            {select("housingStatus")}
          </label>
        </div>
        <div className="two-columns">
          <label>
            Plan to work in Switzerland?
            {select("plansToWork")}
          </label>
          <label>
            Health coverage from home
            {select("healthCoverage")}
          </label>
        </div>

        {saveResult === "error" && (
          <p className="form-error">Couldn't save your changes. Is the backend running?</p>
        )}
        <button className="primary-button" type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : dirty ? "Save changes" : "All changes saved"}
        </button>

        {saveResult === "saved" && (
          <div className="plan-note">
            <strong>Details saved</strong>
            <p>Your current plan was built from your previous answers. Update it so the AI uses the new details.</p>
            <button className="outline-button" type="button" onClick={onRebuildPlan}>
              Update my plan
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/** Keep the frontend's default profile values unless the backend has a real
 * (non-empty) value saved for that field. This stops a brand-new empty profile
 * row from wiping the nice defaults (university, canton, arrival date). */
function mergeProfile(current: Profile, saved: ApiProfile): Profile {
  const merged = { ...current };
  (Object.keys(saved) as (keyof ApiProfile)[]).forEach((key) => {
    const value = saved[key];
    if (value) merged[key] = value;
  });
  return merged;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("onboarding");
  const [profile, setProfile] = useState(initialProfile);
  const [userId, setUserId] = useState<number | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  // Counts plan builds, so updates from a build that was replaced are ignored.
  const planRun = useRef(0);

  // On first load, start loading the AI models in the background, then reuse a
  // saved login (if any) and pull the known info back in.
  useEffect(() => {
    warmUpModels();
    const session = loadSession();
    if (!session) return;
    setUserId(session.id);
    getProfile(session.id)
      .then((saved) => {
        if (saved) setProfile((current) => mergeProfile(current, saved));
      })
      .catch(() => {
        // backend unreachable — fall back to a normal fresh start
      });
  }, []);

  // Step 1 (email): sign in, remember the user, and load any saved details.
  async function handleLogin(email: string) {
    const user = await login(email);
    setUserId(user.id);
    saveSession(user);
    const saved = await getProfile(user.id).catch(() => null);
    if (saved) setProfile((current) => mergeProfile(current, saved));
  }

  // Show the loading screen while the LOCAL AI builds the plan, then the
  // dashboard. The loading screen lists the steps as they are written.
  async function buildPlan(forProfile: Profile) {
    const run = ++planRun.current;
    setPlan(null);
    setScreen("loading");
    try {
      const finished = await generatePlan(forProfile, (soFar) => {
        if (run !== planRun.current) return;
        setPlan(soFar);
      });
      if (run === planRun.current) setPlan(finished);
    } catch {
      if (run === planRun.current) setPlan(null); // dashboard falls back to the built-in starter stops
    } finally {
      if (run === planRun.current) setScreen("dashboard");
    }
  }

  // Finishing onboarding: save the profile, then build the plan.
  async function handleComplete() {
    if (userId != null) {
      await saveProfile(userId, profile).catch(() => {
        // don't block the flow if the save fails; the user can retry later
      });
    }
    await buildPlan(profile);
  }

  // "My profile" edits: save to the server, then reload what the server stored
  // (including the citizenship group it worked out).
  async function handleSaveProfile(draft: Profile) {
    if (userId == null) throw new Error("Not signed in.");
    await saveProfile(userId, draft);
    const details = await getProfileDetails(userId);
    setProfile((current) => mergeProfile({ ...current, ...draft }, details?.profile ?? draft));
  }

  return screen === "onboarding" ? (
    <Onboarding
      profile={profile}
      setProfile={setProfile}
      onLogin={handleLogin}
      onComplete={handleComplete}
    />
  ) : screen === "loading" ? (
    <LoadingScreen profile={profile} plan={plan} />
  ) : (
    <Dashboard
      profile={profile}
      plan={plan}
      userId={userId}
      onReset={() => setScreen("onboarding")}
      onSaveProfile={handleSaveProfile}
      onRebuildPlan={() => buildPlan(profile)}
    />
  );
}
