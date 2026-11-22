import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../locales";
import "./InvoicePanel.css";

interface Props { businessId: string; language: Language }
interface Quota {
  limit: number; used: number; remaining: number; warningAt28: boolean;
}
interface InvoiceSummary {
  id: string; invoiceNumber: string; customerName: string;
  issuedOn: string; totalLkr: string; status: "ISSUED"; createdAt: string;
}
interface InvoiceLine {
  description: string; quantity: string; unitPriceLkr: string;
}
interface InvoiceDetail extends InvoiceSummary {
  customerEmail: string|null; notes: string;
  lines: (InvoiceLine & {lineNumber: number;lineTotalLkr: string})[];
}
interface Page {
  success: true; items: InvoiceSummary[];
  nextCursor: { createdAt: string; id: string } | null;
}
interface QuotaResponse {success: true; billingMonth: string; quota: Quota}
interface IssueResponse {
  success: true;
  invoice: {invoiceNumber: string;totalLkr: string;quota: Quota;replayed: boolean};
}
const translations={
  en:{
    heading:"Invoices", explanation:"An invoice requests payment; it does not record money received.",
    customer:"Customer name",email:"Customer email (optional)",notes:"Notes (optional)",
    description:"Item or service",quantity:"Quantity",price:"Unit price (LKR)",
    addLine:"Add another item",remove:"Remove",create:"Issue invoice",saving:"Issuing...",
    quota:"Invoices used this month",remaining:"remaining",warning:"You are approaching your monthly invoice limit.",
    blocked:"Monthly invoice limit reached. New invoices are disabled.",
    created:"Invoice issued",history:"Issued invoices",empty:"No invoices issued yet.",
    open:"View invoice",close:"Close",more:"Show earlier invoices",refresh:"Refresh",
    disclaimer:"No payment collected. This is not a VAT tax invoice or payment receipt.",
  },
  ta:{
    heading:"விலைப்பட்டியல்கள்",explanation:"விலைப்பட்டியல் பணம் கேட்கும் ஆவணம்; பணம் கிடைத்ததாகப் பதிவு செய்யாது.",
    customer:"வாடிக்கையாளர் பெயர்",email:"மின்னஞ்சல் (விருப்பம்)",notes:"குறிப்புகள் (விருப்பம்)",
    description:"பொருள் / சேவை",quantity:"அளவு",price:"ஒன்றின் விலை (LKR)",
    addLine:"மேலும் பொருள் சேர்க்க",remove:"நீக்கு",create:"விலைப்பட்டியல் உருவாக்கு",saving:"சேமிக்கப்படுகிறது...",
    quota:"இந்த மாதம் உருவாக்கிய விலைப்பட்டியல்கள்",remaining:"மீதமுள்ளவை",warning:"மாதாந்த விலைப்பட்டியல் வரம்பை நெருங்குகிறீர்கள்.",
    blocked:"மாதாந்த விலைப்பட்டியல் வரம்பு எட்டப்பட்டது. புதிய விலைப்பட்டியல் உருவாக்க முடியாது.",
    created:"விலைப்பட்டியல் உருவாக்கப்பட்டது",history:"விலைப்பட்டியல் வரலாறு",empty:"இதுவரை விலைப்பட்டியல்கள் இல்லை.",
    open:"பார்வையிடு",close:"மூடு",more:"முந்தைய விலைப்பட்டியல்கள்",refresh:"புதுப்பி",
    disclaimer:"பணம் பெறப்படவில்லை. இது VAT வரி விலைப்பட்டியல் அல்லது கட்டண ரசீது அல்ல.",
  },
  si:{
    heading:"ඉන්වොයිසි",explanation:"ඉන්වොයිසියක් යනු ගෙවීමක් ඉල්ලා සිටීමකි; ලැබුණු මුදල් සටහනක් නොවේ.",
    customer:"පාරිභෝගික නම",email:"ඊමේල් (විකල්ප)",notes:"සටහන් (විකල්ප)",
    description:"භාණ්ඩය / සේවාව",quantity:"ප්‍රමාණය",price:"ඒකක මිල (LKR)",
    addLine:"තවත් අයිතමයක්",remove:"ඉවත් කරන්න",create:"ඉන්වොයිසිය නිකුත් කරන්න",saving:"නිකුත් කරමින්...",
    quota:"මෙම මාසයේ ඉන්වොයිසි",remaining:"ඉතිරි",warning:"මාසික ඉන්වොයිසි සීමාවට ආසන්නයි.",
    blocked:"මාසික ඉන්වොයිසි සීමාව අවසන්. නව ඉන්වොයිසි නිකුත් කළ නොහැක.",
    created:"ඉන්වොයිසිය නිකුත් කළා",history:"ඉන්වොයිසි ඉතිහාසය",empty:"තවමත් ඉන්වොයිසි නොමැත.",
    open:"බලන්න",close:"වසන්න",more:"පැරණි ඉන්වොයිසි",refresh:"නැවත පූරණය",
    disclaimer:"ගෙවීමක් ලැබී නැත. මෙය VAT බදු ඉන්වොයිසියක් හෝ ගෙවීම් කුවිතාන්සියක් නොවේ.",
  },
} satisfies Record<Language, Record<string,string>>;
function makeLine(): InvoiceLine {
  return {description:"",quantity:"1.00",unitPriceLkr:""};
}
function money(value: string): string {
  const n=Number(value);
  return Number.isFinite(n)
    ?new Intl.NumberFormat("en-LK",{style:"currency",currency:"LKR"}).format(n)
    :value;
}
async function api<T>(url:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(url,{credentials:"include",cache:"no-store",...options});
  const body:unknown=await response.json().catch(()=>null);
  const o=body&&typeof body==="object"?body as Record<string,unknown>:{};
  if(!response.ok||o.success!==true)
    throw new Error(typeof o.code==="string"?o.code:"INVOICE_UNAVAILABLE");
  return body as T;
}
export default function InvoicePanel({businessId,language}:Props){
  const t=translations[language];
  const root="/api/invoices/businesses/"+encodeURIComponent(businessId);
  const [quota,setQuota]=useState<Quota|null>(null);
  const [period,setPeriod]=useState("");
  const [items,setItems]=useState<InvoiceSummary[]>([]);
  const [cursor,setCursor]=useState<Page["nextCursor"]>(null);
  const [selected,setSelected]=useState<InvoiceDetail|null>(null);
  const [customerName,setCustomerName]=useState("");
  const [customerEmail,setCustomerEmail]=useState("");
  const [notes,setNotes]=useState("");
  const [lines,setLines]=useState<InvoiceLine[]>([makeLine()]);
  const [key,setKey]=useState(()=>crypto.randomUUID());
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const refresh=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [q,page]=await Promise.all([
        api<QuotaResponse>(root+"/quota"),
        api<Page>(root+"?limit=20"),
      ]);
      setQuota(q.quota);setPeriod(q.billingMonth);
      setItems(page.items);setCursor(page.nextCursor);
    }catch(e){
      setQuota(null);setItems([]);setCursor(null);
      setError(e instanceof Error?e.message:"INVOICE_UNAVAILABLE");
    }finally{setLoading(false);}
  },[root]);
  useEffect(()=>{void refresh();},[refresh]);
  const updateLine=(index:number,patch:Partial<InvoiceLine>)=>{
    setLines(old=>old.map((line,i)=>i===index?{...line,...patch}:line));
  };
  const create=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(busy||!quota||quota.remaining<=0)return;
    setBusy(true);setError("");setSuccess("");
    try{
      const data=await api<IssueResponse>(root,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          customerName:customerName.trim(),
          customerEmail:customerEmail.trim()||null,
          notes:notes.trim(),
          lines:lines.map(line=>({
            description:line.description.trim(),
            quantity:line.quantity.trim(),unitPriceLkr:line.unitPriceLkr.trim(),
          })),
          idempotencyKey:key,
        }),
      });
      setQuota(data.invoice.quota);
      setSuccess(t.created+": "+data.invoice.invoiceNumber+
        " — "+money(data.invoice.totalLkr));
      setCustomerName("");setCustomerEmail("");setNotes("");
      setLines([makeLine()]);
      setKey(crypto.randomUUID()); // successful response only; preserve key on retry
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"INVOICE_UNAVAILABLE");}
    finally{setBusy(false);}
  };
  const show=async(id:string)=>{
    setBusy(true);setError("");
    try{
      const data=await api<{success:true;invoice:InvoiceDetail}>(root+"/"+encodeURIComponent(id));
      setSelected(data.invoice);
    }catch(e){setError(e instanceof Error?e.message:"INVOICE_UNAVAILABLE");}
    finally{setBusy(false);}
  };
  const more=async()=>{
    if(!cursor||busy)return;
    setBusy(true);setError("");
    try{
      const q=new URLSearchParams({
        limit:"20",cursorCreatedAt:cursor.createdAt,cursorId:cursor.id,
      });
      const page=await api<Page>(root+"?"+q.toString());
      setItems(old=>[...old,...page.items.filter(x=>!old.some(y=>y.id===x.id))]);
      setCursor(page.nextCursor);
    }catch(e){setError(e instanceof Error?e.message:"INVOICE_UNAVAILABLE");}
    finally{setBusy(false);}
  };
  return <section className="noteto-invoices" aria-label={t.heading}>
    <header className="invoice-panel-head">
      <h2>{t.heading}</h2>
      <p>{t.explanation}</p>
      {quota&&<div className="invoice-quota">
        <strong>{t.quota}: {quota.used}/{quota.limit}</strong>
        <span>{quota.remaining} {t.remaining} · {period.slice(0,7)}</span>
        {quota.warningAt28&&quota.remaining>0&&<p role="status">{t.warning}</p>}
        {quota.remaining===0&&<p role="status">{t.blocked}</p>}
      </div>}
    </header>
    <form className="invoice-form" onSubmit={e=>void create(e)}>
      <label>{t.customer}<input required maxLength={150} minLength={2}
        value={customerName} onChange={e=>setCustomerName(e.target.value)}/></label>
      <label>{t.email}<input type="email" maxLength={191}
        value={customerEmail} onChange={e=>setCustomerEmail(e.target.value)}/></label>
      <label className="invoice-wide">{t.notes}<textarea maxLength={500}
        value={notes} onChange={e=>setNotes(e.target.value)}/></label>
      {lines.map((line,index)=><div className="invoice-line" key={index}>
        <label>{t.description}<input required maxLength={200}
          value={line.description} onChange={e=>updateLine(index,{description:e.target.value})}/></label>
        <label>{t.quantity}<input required inputMode="decimal" placeholder="1.00"
          value={line.quantity} onChange={e=>updateLine(index,{quantity:e.target.value})}/></label>
        <label>{t.price}<input required inputMode="decimal" placeholder="0.00"
          value={line.unitPriceLkr} onChange={e=>updateLine(index,{unitPriceLkr:e.target.value})}/></label>
        {lines.length>1&&<button type="button" className="secondary-button"
          onClick={()=>setLines(old=>old.filter((_,i)=>i!==index))}>{t.remove}</button>}
      </div>)}
      {lines.length<20&&<button className="secondary-button invoice-add-line" type="button"
        onClick={()=>setLines(old=>[...old,makeLine()])}>{t.addLine}</button>}
      <button className="primary-button invoice-issue" type="submit"
        disabled={loading||busy||!quota||quota.remaining===0}>
        {busy?t.saving:t.create}
      </button>
    </form>
    {error&&<p className="cashbook-error" role="alert">{error}</p>}
    {success&&<p className="cashbook-success" role="status">{success}</p>}
    <div className="invoice-history">
      <h3>{t.history}</h3>
      {loading?<p>Loading...</p>:items.length===0?<p>{t.empty}</p>:
        items.map(item=><article key={item.id} className="invoice-history-item">
          <div><strong>{item.invoiceNumber}</strong>
            <p>{item.customerName} · {item.issuedOn}</p>
            <small>{t.disclaimer}</small>
          </div>
          <div><strong>{money(item.totalLkr)}</strong>
            <button type="button" disabled={busy} className="secondary-button"
              onClick={()=>void show(item.id)}>{t.open}</button>
          </div>
        </article>)}
      {cursor&&<button type="button" className="secondary-button"
        disabled={busy} onClick={()=>void more()}>{t.more}</button>}
    </div>
    {selected&&<div className="invoice-detail">
      <h3>{selected.invoiceNumber}</h3>
      <p>{selected.customerName} · {selected.issuedOn}</p>
      <ul>{selected.lines.map(l=><li key={l.lineNumber}>
        {l.description} · {l.quantity} × {money(l.unitPriceLkr)}
        <strong>{money(l.lineTotalLkr)}</strong>
      </li>)}</ul>
      <p><strong>{money(selected.totalLkr)}</strong></p>
      <p>{t.disclaimer}</p>
      <button type="button" className="secondary-button"
        onClick={()=>setSelected(null)}>{t.close}</button>
    </div>}
    <div className="invoice-panel-footer">
      <button className="secondary-button" type="button" onClick={()=>void refresh()}
        disabled={loading||busy}>{t.refresh}</button>
      <p>{t.disclaimer}</p>
    </div>
  </section>;
}
