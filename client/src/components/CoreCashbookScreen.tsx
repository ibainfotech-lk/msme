import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../locales";
import InvoicePanel from "./InvoicePanel";
import CashbookReportsPanel from "./CashbookReportsPanel";
import "./CoreCashbookScreen.css";

type EntryType = "INCOME" | "EXPENSE";
type Entry = {
  id: string; transactionType: EntryType; amountLkr: string;
  category: string; description: string; occurredOn: string;
  version: number; createdAt: string; updatedAt: string;
};
type Cursor = { occurredOn: string; id: string };
interface Page {
  success: true; mode: "FULL"; items: Entry[]; nextCursor: Cursor | null;
  reportGenerated: false;
}
interface Props {
  businessId: string;
  businessName: string;
  language: Language;
  onLogout: () => void;
}
type Fields = {
  amountLkr: string; category: string; description: string; occurredOn: string;
};
type FormFields = Fields & { transactionType: EntryType; cashConfirmed: boolean };
const invoiceUiEnabled = import.meta.env.DEV &&
  import.meta.env.VITE_NOTETO_F17_INVOICE_UI_ENABLED === "true";
const reportsUiEnabled = import.meta.env.DEV &&
  import.meta.env.VITE_NOTETO_F17_REPORT_PREVIEW_UI_ENABLED === "true";

const labels = {
  en: {
    heading: "Daily cashbook", subtitle: "Record money you have actually received or paid.",
    cashBasis: "Cash basis only — do not record unpaid invoices or expected income as cash.",
    received: "Add income", paid: "Add expense",
    entryDate: "Cash receipt/payment date", type: "Entry type", amount: "Amount (LKR)",
    category: "Category", description: "Description", confirm: "I confirm this money was received or paid.",
    save: "Save cash entry", saving: "Saving...", history: "Cashbook history",
    empty: "No entries recorded yet.", edit: "Correct", reason: "Reason for correction",
    saveEdit: "Save audited correction", cancel: "Cancel correction",
    loadMore: "Show older entries", refresh: "Refresh", logout: "Log out",
    noReport: "Invoices, taxes and report generation are not enabled in this test build.",
    saved: "Cash entry saved.", corrected: "Correction saved with an audit record.",
    failed: "Your request could not be completed. Check permissions or subscription status.",
    receivedLabel: "Income received", paidLabel: "Expense paid",
  },
  ta: {
    heading: "தினசரி பணப்பதிவு", subtitle: "உண்மையில் பெற்ற அல்லது செலுத்திய பணத்தைப் பதிவு செய்யுங்கள்.",
    cashBasis: "பண அடிப்படை மட்டும் — செலுத்தப்படாத விலைப்பட்டியல் அல்லது எதிர்பார்க்கும் வருமானத்தைப் பதிவு செய்ய வேண்டாம்.",
    received: "வரவு சேர்க்க", paid: "செலவு சேர்க்க",
    entryDate: "பணம் பெற்ற / செலுத்திய தேதி", type: "பதிவு வகை", amount: "தொகை (LKR)",
    category: "வகை", description: "விளக்கம்", confirm: "இந்தப் பணம் பெறப்பட்டது அல்லது செலுத்தப்பட்டது என்பதை உறுதிப்படுத்துகிறேன்.",
    save: "பணப்பதிவைச் சேமி", saving: "சேமிக்கப்படுகிறது...", history: "பணப்பதிவு வரலாறு",
    empty: "இதுவரை பதிவுகள் இல்லை.", edit: "திருத்து", reason: "திருத்தத்திற்கான காரணம்",
    saveEdit: "தணிக்கையுடன் திருத்தத்தைச் சேமி", cancel: "திருத்தத்தை ரத்துசெய்",
    loadMore: "பழைய பதிவுகள்", refresh: "புதுப்பி", logout: "வெளியேறு",
    noReport: "இந்த சோதனைப் பதிப்பில் விலைப்பட்டியல், வரி மற்றும் புதிய அறிக்கை உருவாக்கம் இல்லை.",
    saved: "பணப்பதிவு சேமிக்கப்பட்டது.", corrected: "திருத்தம் தணிக்கைப் பதிவுடன் சேமிக்கப்பட்டது.",
    failed: "கோரிக்கையை நிறைவேற்ற முடியவில்லை. அனுமதி அல்லது சந்தா நிலையைச் சரிபார்க்கவும்.",
    receivedLabel: "வரவு", paidLabel: "செலவு",
  },
  si: {
    heading: "දෛනික මුදල් පොත", subtitle: "ලැබුණු හෝ ගෙවූ සැබෑ මුදල් පමණක් සටහන් කරන්න.",
    cashBasis: "මුදල් පදනම පමණි — නොගෙවූ ඉන්වොයිසි හෝ අපේක්ෂිත ආදායම් ඇතුළත් නොකරන්න.",
    received: "ආදායම් එක් කරන්න", paid: "වියදම් එක් කරන්න",
    entryDate: "මුදල් ලැබුණු / ගෙවූ දිනය", type: "සටහන", amount: "මුදල (LKR)",
    category: "වර්ගය", description: "විස්තරය", confirm: "මෙම මුදල ලැබුණු හෝ ගෙවූ බව තහවුරු කරමි.",
    save: "සටහන සුරකින්න", saving: "සුරකිමින්...", history: "මුදල් සටහන්",
    empty: "තවමත් සටහන් නොමැත.", edit: "නිවැරදි කරන්න", reason: "නිවැරදි කිරීමට හේතුව",
    saveEdit: "විගණන සහිත වෙනස සුරකින්න", cancel: "අවලංගු කරන්න",
    loadMore: "පෙර සටහන්", refresh: "නැවත පූරණය", logout: "ඉවත් වන්න",
    noReport: "මෙම පරීක්ෂණ සංස්කරණයේ ඉන්වොයිසි, බදු සහ වාර්තා සෑදීම සක්‍රීය නැත.",
    saved: "මුදල් සටහන සුරකින ලදී.", corrected: "විගණන සටහන සමඟ නිවැරදි කරන ලදී.",
    failed: "ඉල්ලීම සම්පූර්ණ කළ නොහැක. අවසර සහ දායකත්වය පරීක්ෂා කරන්න.",
    receivedLabel: "ආදායම්", paidLabel: "වියදම්",
  },
} satisfies Record<Language, Record<string, string>>;

function todayColombo(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"Asia/Colombo",year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date());
  const field=(key:string)=>parts.find(p=>p.type===key)?.value??"";
  return field("year")+"-"+field("month")+"-"+field("day");
}
function money(value:string):string {
  const n=Number(value);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-LK",{style:"currency",currency:"LKR"}).format(n) : value;
}
function normalizeAmount(value:string):string|null{
  const input=value.trim();
  if(!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/.test(input))return null;
  const [whole,fraction=""]=input.split(".");
  const fixed=whole+"."+fraction.padEnd(2,"0");
  return Number(fixed)>0 && Number(fixed)<=9999999999.99?fixed:null;
}
function baseForm():FormFields{
  return {transactionType:"INCOME",amountLkr:"",category:"Sales",
    description:"",occurredOn:todayColombo(),cashConfirmed:false};
}
async function request<T>(url:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(url,{credentials:"include",cache:"no-store",...options});
  const data:unknown=await response.json().catch(()=>null);
  const obj=(data&&typeof data==="object"?data:{}) as Record<string,unknown>;
  if(!response.ok||obj.success!==true){
    throw new Error(typeof obj.code==="string"?obj.code:"CASHBOOK_UNAVAILABLE");
  }
  return data as T;
}
export default function CoreCashbookScreen({
  businessId,businessName,language,onLogout,
}:Props){
  const t=labels[language];
  const [items,setItems]=useState<Entry[]>([]);
  const [cursor,setCursor]=useState<Cursor|null>(null);
  const [form,setForm]=useState<FormFields>(baseForm);
  const [requestKey,setRequestKey]=useState(()=>crypto.randomUUID());
  const [selected,setSelected]=useState<Entry|null>(null);
  const [correction,setCorrection]=useState<Fields&{reason:string}>({
    amountLkr:"",category:"",description:"",occurredOn:"",reason:"",
  });
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const root="/api/transactions/businesses/"+encodeURIComponent(businessId);
  const refresh=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const page=await request<Page>(root+"?limit=50");
      if(page.mode!=="FULL"||page.reportGenerated!==false)throw Error("ACCESS_CHANGED");
      setItems(page.items);
      setCursor(page.nextCursor);
    }catch(e){
      setItems([]);setCursor(null);
      setError(e instanceof Error?e.message:t.failed);
    }finally{setLoading(false);}
  },[root,t.failed]);
  useEffect(()=>{void refresh();},[refresh]);

  const add=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(busy||!form.cashConfirmed)return;
    const amountLkr=normalizeAmount(form.amountLkr);
    if(!amountLkr){setError("INVALID_CASH_AMOUNT");return;}
    setBusy(true);setError("");setNotice("");
    try{
      await request(root,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          transactionType:form.transactionType,cashConfirmed:true,
          amountLkr,category:form.category.trim(),description:form.description.trim(),
          occurredOn:form.occurredOn,idempotencyKey:requestKey,
        }),
      });
      setForm(baseForm());
      setRequestKey(crypto.randomUUID()); // only after server-confirmed success
      await refresh();
      setNotice(t.saved);
    }catch(e){setError(e instanceof Error?e.message:t.failed);}
    finally{setBusy(false);}
  };
  const choose=(entry:Entry)=>{
    setSelected(entry);setNotice("");setError("");
    setCorrection({amountLkr:entry.amountLkr,category:entry.category,
      description:entry.description,occurredOn:entry.occurredOn,reason:""});
  };
  const edit=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(!selected||busy)return;
    const amountLkr=normalizeAmount(correction.amountLkr);
    if(!amountLkr){setError("INVALID_CASH_AMOUNT");return;}
    setBusy(true);setError("");setNotice("");
    try{
      await request(root+"/"+encodeURIComponent(selected.id),{
        method:"PATCH",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          expectedVersion:selected.version,amountLkr,
          category:correction.category.trim(),description:correction.description.trim(),
          occurredOn:correction.occurredOn,reason:correction.reason.trim(),
        }),
      });
      setSelected(null);
      await refresh();
      setNotice(t.corrected);
    }catch(e){setError(e instanceof Error?e.message:t.failed);}
    finally{setBusy(false);}
  };
  const more=async()=>{
    if(!cursor||busy)return;
    setBusy(true);setError("");
    try{
      const q=new URLSearchParams({limit:"50",
        cursorDate:cursor.occurredOn,cursorId:cursor.id});
      const page=await request<Page>(root+"?"+q.toString());
      if(page.mode!=="FULL")throw Error("ACCESS_CHANGED");
      setItems(old=>[...old,...page.items.filter(x=>!old.some(y=>y.id===x.id))]);
      setCursor(page.nextCursor);
    }catch(e){setError(e instanceof Error?e.message:t.failed);}
    finally{setBusy(false);}
  };
  return <section className="core-cashbook" aria-label={t.heading}>
    <div className="cashbook-heading">
      <h2>{t.heading}</h2>
      <strong>{businessName}</strong>
      <p>{t.subtitle}</p>
      <p className="cashbook-notice">{t.cashBasis}</p>
    </div>
    <form className="cashbook-form" onSubmit={e=>void add(e)}>
      <div className="cashbook-type" role="group" aria-label={t.type}>
        <button type="button" className={form.transactionType==="INCOME"?"active":""}
          onClick={()=>setForm({...form,transactionType:"INCOME",category:"Sales"})}>{t.received}</button>
        <button type="button" className={form.transactionType==="EXPENSE"?"active":""}
          onClick={()=>setForm({...form,transactionType:"EXPENSE",category:"Supplies"})}>{t.paid}</button>
      </div>
      <label>{t.amount}<input required inputMode="decimal" value={form.amountLkr}
        placeholder="0.00" onChange={e=>setForm({...form,amountLkr:e.target.value})}/></label>
      <label>{t.category}<input required maxLength={100} value={form.category}
        onChange={e=>setForm({...form,category:e.target.value})}/></label>
      <label>{t.entryDate}<input type="date" required max={todayColombo()} value={form.occurredOn}
        onChange={e=>setForm({...form,occurredOn:e.target.value})}/></label>
      <label>{t.description}<input maxLength={500} value={form.description}
        onChange={e=>setForm({...form,description:e.target.value})}/></label>
      <label className="cashbook-confirm">
        <input type="checkbox" checked={form.cashConfirmed}
          onChange={e=>setForm({...form,cashConfirmed:e.target.checked})}/>
        <span>{t.confirm}</span>
      </label>
      <button className="primary-button" type="submit" disabled={busy||!form.cashConfirmed}>
        {busy?t.saving:t.save}
      </button>
    </form>
    <div className="cashbook-list">
      <h3>{t.history}</h3>
      {loading?<p>Loading...</p>:items.length===0?<p>{t.empty}</p>:
        items.map(entry=><article className="cashbook-row" key={entry.id}>
          <div>
            <strong>{entry.category}</strong>
            <p>{entry.description}</p>
            <small>{entry.occurredOn} · {entry.transactionType==="INCOME"?t.receivedLabel:t.paidLabel}</small>
          </div>
          <div className="cashbook-row-action">
            <strong>{entry.transactionType==="INCOME"?"+":"−"} {money(entry.amountLkr)}</strong>
            <button type="button" disabled={busy} onClick={()=>choose(entry)}>{t.edit}</button>
          </div>
        </article>)}
      {cursor&&<button type="button" className="secondary-button"
        onClick={()=>void more()} disabled={busy}>{t.loadMore}</button>}
    </div>
    {selected&&<form className="cashbook-form" onSubmit={e=>void edit(e)}>
      <h3>{t.edit}: {selected.transactionType==="INCOME"?t.receivedLabel:t.paidLabel}</h3>
      <label>{t.amount}<input required inputMode="decimal" value={correction.amountLkr}
        onChange={e=>setCorrection({...correction,amountLkr:e.target.value})}/></label>
      <label>{t.category}<input required maxLength={100} value={correction.category}
        onChange={e=>setCorrection({...correction,category:e.target.value})}/></label>
      <label>{t.entryDate}<input type="date" required max={todayColombo()} value={correction.occurredOn}
        onChange={e=>setCorrection({...correction,occurredOn:e.target.value})}/></label>
      <label>{t.description}<input maxLength={500} value={correction.description}
        onChange={e=>setCorrection({...correction,description:e.target.value})}/></label>
      <label>{t.reason}<textarea required minLength={3} maxLength={500}
        value={correction.reason} onChange={e=>setCorrection({...correction,reason:e.target.value})}/></label>
      <button className="primary-button" type="submit" disabled={busy}>{t.saveEdit}</button>
      <button type="button" className="secondary-button" disabled={busy}
        onClick={()=>setSelected(null)}>{t.cancel}</button>
    </form>}
    {error&&<p role="alert" className="cashbook-error">{error}</p>}
    {notice&&<p role="status" className="cashbook-success">{notice}</p>}
    <p className="cashbook-notice">{t.noReport}</p>
    {invoiceUiEnabled && <InvoicePanel businessId={businessId} language={language} />}
    {reportsUiEnabled && <CashbookReportsPanel businessId={businessId} language={language} />}
    <div className="cashbook-footer">
      <button className="secondary-button" type="button" onClick={()=>void refresh()}
        disabled={loading||busy}>{t.refresh}</button>
      <button className="text-button" type="button" onClick={onLogout}>{t.logout}</button>
    </div>
  </section>;
}
