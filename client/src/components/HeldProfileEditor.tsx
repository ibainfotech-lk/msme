import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../locales";
import "./HeldProfileEditor.css";

interface ProfileFields {
  fullName: string;
  preferredLanguage: Language;
  displayName: string;
  contactEmail: string;
  address: string;
}
interface ProfileData {
  success: true;
  mode: "HOLD";
  businessId: string;
  businessLegalName: string;
  personalPhone: string;
  registrationEmail: string | null;
  version: number;
  profile: ProfileFields;
}
interface ProfileSaved { success: true; version: number; mode: "HOLD" }
interface Props { businessId: string; businessName: string; language: Language }

const copy = {
  en: {
    title: "Profile details",
    help: "You may edit your contact details while your subscription is on hold.",
    legal: "Registered business name (locked)",
    phone: "Sign-in mobile number (locked)",
    registeredEmail: "Registration email (locked)",
    fullName: "Your full name",
    language: "Preferred language",
    displayName: "Business display name",
    contactEmail: "Business contact email (not a login address)",
    address: "Business contact address",
    save: "Save profile changes",
    cancel: "Reset changes",
    loading: "Loading your profile...",
    unavailable: "Profile information is unavailable. Your account or permissions may require review.",
    saving: "Saving profile...",
    saved: "Profile saved with an audit record.",
    unchanged: "No profile changes to save.",
    restricted: "This form cannot change your verified identity, subscriptions or accounting records.",
  },
  ta: {
    title: "சுயவிவர விபரங்கள்",
    help: "சந்தா நிறுத்தப்பட்டிருந்தாலும் தொடர்பு விபரங்களைத் திருத்தலாம்.",
    legal: "பதிவுசெய்யப்பட்ட வணிகப் பெயர் (மாற்ற முடியாது)",
    phone: "உள்நுழைவு கைபேசி எண் (மாற்ற முடியாது)",
    registeredEmail: "பதிவு மின்னஞ்சல் (மாற்ற முடியாது)",
    fullName: "உங்கள் முழுப் பெயர்",
    language: "விரும்பும் மொழி",
    displayName: "வணிகக் காட்சிப் பெயர்",
    contactEmail: "வணிகத் தொடர்பு மின்னஞ்சல் (உள்நுழைவுக்கு அல்ல)",
    address: "வணிகத் தொடர்பு முகவரி",
    save: "சுயவிவர மாற்றங்களைச் சேமிக்கவும்",
    cancel: "மாற்றங்களை மீட்டமை",
    loading: "சுயவிவரம் ஏற்றப்படுகிறது...",
    unavailable: "சுயவிவரத்தைப் பெற முடியவில்லை. அனுமதிகளைச் சரிபார்க்கவும்.",
    saving: "சேமிக்கப்படுகிறது...",
    saved: "சுயவிவரம் தணிக்கைப் பதிவுடன் சேமிக்கப்பட்டது.",
    unchanged: "சேமிக்க மாற்றங்கள் இல்லை.",
    restricted: "சரிபார்க்கப்பட்ட அடையாளம், சந்தா மற்றும் கணக்கியல் பதிவுகளை இங்கே மாற்ற முடியாது.",
  },
  si: {
    title: "පැතිකඩ තොරතුරු",
    help: "දායකත්වය සීමා වී තිබුණත් සම්බන්ධතා තොරතුරු සංස්කරණය කළ හැක.",
    legal: "ලියාපදිංචි ව්‍යාපාර නාමය (වෙනස් කළ නොහැක)",
    phone: "පිවිසුම් දුරකථන අංකය (වෙනස් කළ නොහැක)",
    registeredEmail: "ලියාපදිංචි විද්‍යුත් තැපෑල (වෙනස් කළ නොහැක)",
    fullName: "ඔබගේ සම්පූර්ණ නම",
    language: "කැමති භාෂාව",
    displayName: "ව්‍යාපාර ප්‍රදර්ශන නාමය",
    contactEmail: "ව්‍යාපාර සම්බන්ධතා විද්‍යුත් තැපෑල",
    address: "ව්‍යාපාර සම්බන්ධතා ලිපිනය",
    save: "පැතිකඩ වෙනස්කම් සුරකින්න",
    cancel: "වෙනස්කම් අවලංගු කරන්න",
    loading: "පැතිකඩ පූරණය වෙමින්...",
    unavailable: "පැතිකඩ තොරතුරු ලබාගත නොහැක. අවසර පරීක්ෂා කරන්න.",
    saving: "සුරකිමින්...",
    saved: "විගණන සටහන සමඟ පැතිකඩ සුරකින ලදි.",
    unchanged: "සුරැකීමට වෙනස්කම් නොමැත.",
    restricted: "සත්‍යාපිත අනන්‍යතාව, දායකත්වය හෝ ගිණුම් වාර්තා මෙතැනින් වෙනස් කළ නොහැක.",
  },
} satisfies Record<Language, Record<string, string>>;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  const json: unknown = await response.json().catch(() => null);
  const item = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (!response.ok || item.success !== true) {
    throw new Error(typeof item.code === "string" ? item.code : "PROFILE_UNAVAILABLE");
  }
  return json as T;
}

export default function HeldProfileEditor({ businessId, businessName, language }: Props) {
  const t = copy[language];
  const [loaded, setLoaded] = useState<ProfileData | null>(null);
  const [draft, setDraft] = useState<ProfileFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const url = "/api/hold-history/businesses/" + encodeURIComponent(businessId) + "/profile";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await request<ProfileData>(url);
      if (response.mode !== "HOLD" || !Number.isSafeInteger(response.version) ||
          typeof response.profile?.fullName !== "string") {
        throw new Error("INVALID_PROFILE_RESPONSE");
      }
      setLoaded(response);
      setDraft({
        ...response.profile,
        displayName: response.profile.displayName || response.businessLegalName,
      });
    } catch {
      setLoaded(null);
      setDraft(null);
      setError(copy[language].unavailable);
    } finally {
      setLoading(false);
    }
  }, [url, language]);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loaded || !draft || busy) return;
    if (JSON.stringify(loaded.profile) === JSON.stringify(draft)) {
      setSuccess(t.unchanged);
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await request<ProfileSaved>(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: loaded.version, ...draft }),
      });
      await refresh();
      setSuccess(t.saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.unavailable);
    } finally { setBusy(false); }
  };

  return (
    <section className="held-profile-editor" aria-label={t.title}>
      <h3>{t.title}</h3>
      <p>{t.help}</p>
      {loading && <p role="status">{t.loading}</p>}
      {!loading && loaded && draft && (
        <form onSubmit={event => void save(event)} className="held-profile-form">
          <label>{t.legal}<input readOnly value={loaded.businessLegalName || businessName} /></label>
          <label>{t.phone}<input readOnly value={loaded.personalPhone} /></label>
          <label>{t.registeredEmail}<input readOnly value={loaded.registrationEmail ?? ""}/></label>
          <label>{t.fullName}<input required minLength={2} maxLength={150}
            value={draft.fullName} onChange={event => setDraft({ ...draft, fullName: event.target.value })}/></label>
          <label>{t.language}
            <select value={draft.preferredLanguage}
              onChange={event => setDraft({ ...draft, preferredLanguage: event.target.value as Language })}>
              <option value="en">English</option>
              <option value="ta">தமிழ்</option>
              <option value="si">සිංහල</option>
            </select>
          </label>
          <label>{t.displayName}<input required minLength={2} maxLength={150}
            value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })}/></label>
          <label>{t.contactEmail}<input type="email" maxLength={191}
            value={draft.contactEmail} onChange={event => setDraft({ ...draft, contactEmail: event.target.value })}/></label>
          <label>{t.address}<textarea maxLength={350}
            value={draft.address} onChange={event => setDraft({ ...draft, address: event.target.value })}/></label>
          <p className="held-profile-note">{t.restricted}</p>
          <div className="held-profile-actions">
            <button type="submit" disabled={busy}>{busy ? t.saving : t.save}</button>
            <button type="button" disabled={busy} onClick={() => setDraft({ ...loaded.profile })}>{t.cancel}</button>
          </div>
        </form>
      )}
      {error && <p className="hold-error" role="alert">{error}</p>}
      {success && <p className="hold-success" role="status">{success}</p>}
    </section>
  );
}
