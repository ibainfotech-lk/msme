import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../locales";
import "./HeldAccountScreen.css";
import HeldProfileEditor from "./HeldProfileEditor";

type EntryType = "INCOME" | "EXPENSE";
type ArchiveType = "DAILY" | "WEEKLY" | "YEARLY";

interface PreviousEntry {
  id: string;
  type: EntryType;
  amountLkr: string;
  category: string;
  description: string;
  occurredOn: string;
  createdAt: string;
  version: number;
}

interface PreviousReport {
  id: string;
  type: ArchiveType;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
}
interface HistoryResponse<T> {
  success: boolean;
  mode: "FULL" | "HOLD";
  items: T[];
  limitedTo: number;
  newEntryAllowed: false;
  reportGenerationAllowed: false;
}
interface ArrearsLine {
  billingMonth: string;
  chargeLkr: string;
  waivedLkr: string;
  verifiedPaidLkr: string;
  outstandingLkr: string;
}
interface VerifiedArrearsStatement {
  success: true;
  currency: "LKR";
  asOf: string;
  lines: ArrearsLine[];
  totalOutstandingLkr: string;
  penaltyLkr: string;
  completeThroughMonth: string;
  paymentActionAllowed: false;
}
interface PreviousEntryEdit {
  amountLkr: string;
  category: string;
  description: string;
  occurredOn: string;
  reason: string;
}

interface Props {
  businessId: string;
  businessName: string;
  language: Language;
  onLogout: () => void;
}

const copy = {
  en: {
    title: "Account on Hold",
    subtitle: "Your subscription needs payment review. You can still see your earlier records.",
    notice: "New income, expenses, invoices and reports are unavailable while the subscription is on hold.",
    dues: "Outstanding subscription charges",
    duesNote: "Verified monthly charges only. No bank payment is initiated here.",
    duesUnavailable: "Balance unavailable. Your billing history needs review; no amount is assumed.",
    month: "Billing month",
    verifiedPaid: "Verified payments",
    remaining: "Amount due",
    totalDue: "Total outstanding",
    penalty: "Late penalty",
    asOf: "Checked as of",
    noDue: "No currently due monthly charges are recorded.",
    tabsEntries: "Previous entries",
    tabsReports: "Saved reports",
    previous: "Entries saved before your account was placed on hold",
    reports: "Previously generated reports",
    noEntries: "No previous entries are available.",
    noReports: "No archived reports are available.",
    correct: "Correct entry",
    download: "Download PDF",
    editTitle: "Correct a previous entry",
    amount: "Amount (LKR)",
    category: "Category",
    description: "Description",
    occurredOn: "Entry date",
    reason: "Reason for correction",
    reasonHint: "A reason is required for the audit trail.",
    save: "Save audited correction",
    cancel: "Cancel",
    refresh: "Refresh history",
    logout: "Log out",
    profile: "Business profile",
    profileNote: "Profile editing will be available after its secure API is connected.",
    immutable: "Previously saved reports stay unchanged when a historical entry is edited.",
    loading: "Loading previous records...",
    saving: "Saving...",
    saved: "Historical entry corrected and audited.",
    downloading: "Preparing saved PDF...",
    income: "Income",
    expense: "Expense",
    limit: "Showing at most 100 existing records.",
    unavailable: "Your earlier records could not be loaded. Check your session and try again.",
    sessionChanged: "Your subscription access changed. Sign in again to refresh permissions.",
  },
  ta: {
    title: "கணக்கு தற்காலிகமாக நிறுத்தப்பட்டுள்ளது",
    subtitle: "சந்தா கட்டண நிலை சரிபார்க்கப்பட வேண்டும். முந்தைய பதிவுகளைத் தொடர்ந்து பார்க்கலாம்.",
    notice: "சந்தா நிறுத்தத்தில் இருக்கும் போது புதிய வரவு, செலவு, விலைப்பட்டியல் அல்லது அறிக்கையை உருவாக்க முடியாது.",
    dues: "நிலுவை சந்தா தொகை",
    duesNote: "சரிபார்க்கப்பட்ட மாதாந்த நிலுவை மட்டுமே காட்டப்படுகிறது. இங்கு வங்கிக் கட்டணம் தொடங்கப்படாது.",
    duesUnavailable: "நிலுவைத் தொகையைச் சரிபார்க்க முடியவில்லை. கட்டணப் பதிவுகள் ஆய்வு செய்யப்பட வேண்டும்.",
    month: "கட்டண மாதம்",
    verifiedPaid: "சரிபார்த்த கட்டணம்",
    remaining: "நிலுவை",
    totalDue: "மொத்த நிலுவை",
    penalty: "தாமத அபராதம்",
    asOf: "சரிபார்த்த தேதி",
    noDue: "தற்போது செலுத்த வேண்டிய தொகை பதிவு செய்யப்படவில்லை.",
    tabsEntries: "முந்தைய பதிவுகள்",
    tabsReports: "சேமித்த அறிக்கைகள்",
    previous: "கணக்கு நிறுத்தத்திற்கு முன் சேமித்த பதிவுகள்",
    reports: "முன்பே உருவாக்கிய அறிக்கைகள்",
    noEntries: "முந்தைய பதிவுகள் எதுவும் இல்லை.",
    noReports: "சேமித்த அறிக்கைகள் எதுவும் இல்லை.",
    correct: "பதிவைத் திருத்து",
    download: "PDF பதிவிறக்கு",
    editTitle: "முந்தைய பதிவைத் திருத்து",
    amount: "தொகை (LKR)",
    category: "வகை",
    description: "விளக்கம்",
    occurredOn: "பதிவு தேதி",
    reason: "திருத்தத்திற்கான காரணம்",
    reasonHint: "தணிக்கைப் பதிவுக்கு காரணம் அவசியம்.",
    save: "திருத்தத்தைச் சேமி",
    cancel: "ரத்துசெய்",
    refresh: "மீண்டும் ஏற்று",
    logout: "வெளியேறு",
    profile: "வணிகச் சுயவிவரம்",
    profileNote: "பாதுகாப்பான API இணைக்கப்பட்ட பின் சுயவிவரத் திருத்தம் கிடைக்கும்.",
    immutable: "பழைய பதிவைத் திருத்தினாலும் முன்பே சேமித்த அறிக்கைகள் மாற்றப்படாது.",
    loading: "முந்தைய பதிவுகள் ஏற்றப்படுகின்றன...",
    saving: "சேமிக்கப்படுகிறது...",
    saved: "முந்தைய பதிவு தணிக்கையுடன் திருத்தப்பட்டது.",
    downloading: "PDF தயாராகிறது...",
    income: "வரவு",
    expense: "செலவு",
    limit: "அதிகபட்சம் 100 பதிவுகள் காட்டப்படும்.",
    unavailable: "முந்தைய பதிவுகளை ஏற்ற முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",
    sessionChanged: "சந்தா அனுமதி மாறியுள்ளது. மீண்டும் உள்நுழையவும்.",
  },
  si: {
    title: "ගිණුම තාවකාලිකව සීමා කර ඇත",
    subtitle: "දායකත්ව ගෙවීම් තත්ත්වය සමාලෝචනය කළ යුතුය. පෙර වාර්තා බැලිය හැක.",
    notice: "නව ආදායම්, වියදම්, ඉන්වොයිසි සහ වාර්තා සෑදීම තාවකාලිකව අවහිර කර ඇත.",
    dues: "හිඟ දායකත්ව මුදල",
    duesNote: "සත්‍යාපිත මාසික හිඟ මුදල් පමණක් පෙන්වයි. මෙතැනින් බැංකු ගෙවීමක් සිදු නොවේ.",
    duesUnavailable: "හිඟ මුදල ලබාගත නොහැක. ගෙවීම් ඉතිහාසය සමාලෝචනය කළ යුතුය.",
    month: "බිල්පත් මාසය",
    verifiedPaid: "සත්‍යාපිත ගෙවීම්",
    remaining: "හිඟ මුදල",
    totalDue: "මුළු හිඟ මුදල",
    penalty: "ප්‍රමාද දඩය",
    asOf: "පරීක්ෂා කළ දිනය",
    noDue: "දැනට ගෙවිය යුතු මාසික ගාස්තු සටහන් වී නොමැත.",
    tabsEntries: "පෙර ඇතුළත් කිරීම්",
    tabsReports: "සුරකින ලද වාර්තා",
    previous: "ගිණුම සීමා කිරීමට පෙර සුරකින ලද ඇතුළත් කිරීම්",
    reports: "කලින් සාදන ලද වාර්තා",
    noEntries: "පෙර ඇතුළත් කිරීම් නොමැත.",
    noReports: "සුරකින ලද වාර්තා නොමැත.",
    correct: "නිවැරදි කරන්න",
    download: "PDF බාගන්න",
    editTitle: "පෙර ඇතුළත් කිරීම නිවැරදි කරන්න",
    amount: "මුදල (LKR)",
    category: "වර්ගය",
    description: "විස්තරය",
    occurredOn: "දිනය",
    reason: "නිවැරදි කිරීමට හේතුව",
    reasonHint: "විගණන සටහන සඳහා හේතුවක් අවශ්‍යයි.",
    save: "විගණන සහිත නිවැරදි කිරීම සුරකින්න",
    cancel: "අවලංගු කරන්න",
    refresh: "නැවත පූරණය",
    logout: "ඉවත් වන්න",
    profile: "ව්‍යාපාර තොරතුරු",
    profileNote: "ආරක්ෂිත API එක සම්බන්ධ කළ පසු තොරතුරු සංස්කරණය කළ හැක.",
    immutable: "පෙර ඇතුළත් කිරීමක් වෙනස් කළත් සුරකින ලද වාර්තා වෙනස් නොවේ.",
    loading: "පෙර වාර්තා පූරණය වෙමින්...",
    saving: "සුරකිමින්...",
    saved: "පෙර ඇතුළත් කිරීම විගණන සටහනක් සමඟ නිවැරදි කෙරිණි.",
    downloading: "PDF සූදානම් කරමින්...",
    income: "ආදායම්",
    expense: "වියදම්",
    limit: "උපරිම වාර්තා 100ක් පෙන්වයි.",
    unavailable: "පෙර වාර්තා පූරණය කළ නොහැක. නැවත උත්සාහ කරන්න.",
    sessionChanged: "දායකත්ව අවසරය වෙනස් වී ඇත. නැවත පිවිසෙන්න.",
  },
} satisfies Record<Language, Record<string, string>>;

function formatMoney(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-LK", { style: "currency", currency: "LKR" }).format(amount)
    : value;
}

function formatDate(value: string, language: Language): string {
  if (!value) return "";
  const locale = language === "ta" ? "ta-LK" : language === "si" ? "si-LK" : "en-LK";
  const date = new Date(value.includes("T") ? value : value + "T00:00:00");
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(date)
    : value;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store", ...init });
  const data: unknown = await response.json().catch(() => null);
  const object = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (!response.ok || object.success !== true) {
    throw new Error(typeof object.code === "string" ? object.code : "REQUEST_UNAVAILABLE");
  }
  return data as T;
}

export default function HeldAccountScreen({ businessId, businessName, language, onLogout }: Props) {
  const t = copy[language];
  const [entries, setEntries] = useState<PreviousEntry[]>([]);
  const [reports, setReports] = useState<PreviousReport[]>([]);
  const [arrears, setArrears] = useState<VerifiedArrearsStatement | null>(null);
  const [arrearsUnavailable, setArrearsUnavailable] = useState(true);
  const [tab, setTab] = useState<"entries" | "reports">("entries");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<PreviousEntry | null>(null);
  const [draft, setDraft] = useState<PreviousEntryEdit>({
    amountLkr: "", category: "", description: "", occurredOn: "", reason: "",
  });

  const root = "/api/hold-history/businesses/" + encodeURIComponent(businessId);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    setMessage("");
    setArrears(null);
    setArrearsUnavailable(true);
    try {
      const [a, b] = await Promise.all([
        apiJson<HistoryResponse<PreviousEntry>>(root + "/entries"),
        apiJson<HistoryResponse<PreviousReport>>(root + "/reports"),
      ]);
      if (a.mode !== "HOLD" || b.mode !== "HOLD" ||
          a.newEntryAllowed !== false || b.reportGenerationAllowed !== false) {
        throw new Error("SUBSCRIPTION_ACCESS_CHANGED");
      }
      setEntries(a.items);
      setReports(b.items);
      // A billing error must never be displayed as LKR 0.00 or inferred
      // from elapsed months. Continue to allow historical records safely.
      try {
        const verified = await apiJson<VerifiedArrearsStatement>(root + "/arrears");
        if (verified.currency !== "LKR" ||
            verified.paymentActionAllowed !== false ||
            typeof verified.totalOutstandingLkr !== "string" ||
            !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(verified.totalOutstandingLkr) ||
            !Array.isArray(verified.lines)) {
          throw new Error("UNVERIFIED_BILLING_STATEMENT");
        }
        setArrears(verified);
        setArrearsUnavailable(false);
      } catch {
        setArrears(null);
        setArrearsUnavailable(true);
      }
    } catch (cause) {
      setEntries([]);
      setReports([]);
      setArrears(null);
      setArrearsUnavailable(true);
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "SUBSCRIPTION_ACCESS_CHANGED" ? t.sessionChanged : t.unavailable);
    } finally {
      setLoading(false);
    }
  }, [root, t.sessionChanged, t.unavailable]);

  useEffect(() => { void refresh(); }, [refresh]);

  const startEdit = (entry: PreviousEntry) => {
    setSelected(entry);
    setDraft({
      amountLkr: entry.amountLkr,
      category: entry.category,
      description: entry.description,
      occurredOn: entry.occurredOn,
      reason: "",
    });
    setError("");
    setMessage("");
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || busy) return;
    const amount = Number(draft.amountLkr);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999999.99) {
      setError(t.unavailable);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiJson(root + "/entries/" + encodeURIComponent(selected.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: selected.version,
          amountLkr: amount.toFixed(2),
          category: draft.category.trim(),
          description: draft.description.trim(),
          occurredOn: draft.occurredOn,
          reason: draft.reason.trim(),
        }),
      });
      setSelected(null);
      await refresh();
      setMessage(t.saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = async (report: PreviousReport) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage(t.downloading);
    try {
      const response = await fetch(root + "/reports/" + encodeURIComponent(report.id) + "/pdf", {
        method: "GET", credentials: "include", cache: "no-store",
      });
      if (!response.ok || !response.headers.get("Content-Type")?.includes("application/pdf")) {
        const data: unknown = await response.json().catch(() => null);
        const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
        throw new Error(typeof obj.code === "string" ? obj.code : "DOWNLOAD_UNAVAILABLE");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const element = document.createElement("a");
        element.href = url;
        element.download = "noteto-" + report.type.toLowerCase() + "-" +
          report.generatedAt.slice(0, 10) + ".pdf";
        document.body.appendChild(element);
        element.click();
        element.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      setMessage("");
    } catch (cause) {
      setMessage("");
      setError(cause instanceof Error ? cause.message : t.unavailable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="hold-screen" aria-labelledby="hold-title">
      <header className="hold-header">
        <span className="hold-pill">{t.title}</span>
        <h2 id="hold-title">{businessName}</h2>
        <p>{t.subtitle}</p>
        <p className="hold-notice">{t.notice}</p>
      </header>

      <section className="hold-dues" aria-label={t.dues}>
        <strong>{t.dues}</strong>
        {arrears && !arrearsUnavailable ? (
          <>
            {arrears.lines.filter(line => Number(line.outstandingLkr) > 0).length === 0
              ? <p>{t.noDue}</p>
              : <div className="hold-arrears-lines">
                {arrears.lines.filter(line => Number(line.outstandingLkr) > 0).map(line => (
                  <div className="hold-arrears-line" key={line.billingMonth}>
                    <div>
                      <strong>{t.month}: {formatDate(line.billingMonth, language)}</strong>
                      <small>{t.verifiedPaid}: {formatMoney(line.verifiedPaidLkr)}</small>
                    </div>
                    <strong>{t.remaining}: {formatMoney(line.outstandingLkr)}</strong>
                  </div>
                ))}
              </div>}
            <div className="hold-arrears-total">
              <strong>{t.totalDue}</strong>
              <strong>{formatMoney(arrears.totalOutstandingLkr)}</strong>
            </div>
            <p>{t.penalty}: {formatMoney(arrears.penaltyLkr)}</p>
            <p className="hold-note">{t.asOf}: {formatDate(arrears.asOf, language)}</p>
          </>
        ) : <p className="hold-billing-pending" role="status">{t.duesUnavailable}</p>}
        <p className="hold-note">{t.duesNote}</p>
      </section>

      <HeldProfileEditor businessId={businessId} businessName={businessName} language={language} />

      <div className="hold-tabs" role="group" aria-label={t.title}>
        <button type="button" aria-pressed={tab === "entries"}
          className={tab === "entries" ? "selected" : ""}
          onClick={() => { setTab("entries"); setSelected(null); }}>{t.tabsEntries}</button>
        <button type="button" aria-pressed={tab === "reports"}
          className={tab === "reports" ? "selected" : ""}
          onClick={() => { setTab("reports"); setSelected(null); }}>{t.tabsReports}</button>
      </div>

      <div className="hold-history" aria-live="polite">
        {loading ? <p>{t.loading}</p> : tab === "entries" ? (
          <>
            <h3>{t.previous}</h3>
            {entries.length === 0 ? <p>{t.noEntries}</p> : (
              <div className="hold-list">
                {entries.map(entry => (
                  <article className="hold-item" key={entry.id}>
                    <div>
                      <strong>{entry.category}</strong>
                      <p>{entry.description}</p>
                      <small>{formatDate(entry.occurredOn, language)} ·
                        {" "}{entry.type === "INCOME" ? t.income : t.expense}</small>
                    </div>
                    <div className="hold-item-actions">
                      <strong>{formatMoney(entry.amountLkr)}</strong>
                      <button type="button" className="hold-link"
                        disabled={busy} onClick={() => startEdit(entry)}>{t.correct}</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <h3>{t.reports}</h3>
            {reports.length === 0 ? <p>{t.noReports}</p> : (
              <div className="hold-list">
                {reports.map(report => (
                  <article className="hold-item" key={report.id}>
                    <div>
                      <strong>{report.type}</strong>
                      <p>{formatDate(report.periodStart, language)} – {formatDate(report.periodEnd, language)}</p>
                      <small>{formatDate(report.generatedAt, language)}</small>
                    </div>
                    <button type="button" className="hold-link"
                      disabled={busy} onClick={() => void downloadPdf(report)}>{t.download}</button>
                  </article>
                ))}
              </div>
            )}
            <p className="hold-note">{t.immutable}</p>
          </>
        )}
        <p className="hold-note">{t.limit}</p>
      </div>

      {selected && tab === "entries" && (
        <form className="hold-edit" onSubmit={event => void saveEdit(event)}>
          <h3>{t.editTitle}</h3>
          <label>{t.amount}<input required inputMode="decimal" value={draft.amountLkr}
            onChange={event => setDraft({ ...draft, amountLkr: event.target.value })}/></label>
          <label>{t.category}<input required maxLength={100} value={draft.category}
            onChange={event => setDraft({ ...draft, category: event.target.value })}/></label>
          <label>{t.description}<input maxLength={500} value={draft.description}
            onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
          <label>{t.occurredOn}<input type="date" required value={draft.occurredOn}
            onChange={event => setDraft({ ...draft, occurredOn: event.target.value })}/></label>
          <label>{t.reason}<textarea required minLength={3} maxLength={500} value={draft.reason}
            onChange={event => setDraft({ ...draft, reason: event.target.value })}/></label>
          <p className="hold-note">{t.reasonHint}</p>
          <div className="hold-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? t.saving : t.save}</button>
            <button className="secondary-button" type="button" disabled={busy}
              onClick={() => setSelected(null)}>{t.cancel}</button>
          </div>
        </form>
      )}

      {error && <p className="hold-error" role="alert">{error}</p>}
      {message && <p className="hold-success" role="status">{message}</p>}
      <div className="hold-actions">
        <button className="secondary-button" type="button" disabled={loading || busy}
          onClick={() => void refresh()}>{t.refresh}</button>
        <button className="text-button" type="button" onClick={onLogout}>{t.logout}</button>
      </div>
    </section>
  );
}
