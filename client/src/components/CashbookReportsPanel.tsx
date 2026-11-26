import { useState } from "react";
import type { FormEvent } from "react";
import type { Language } from "../locales";
import "./CashbookReportsPanel.css";

type Period = "DAILY" | "WEEKLY" | "YEARLY";
type Totals = {
  cashInLkr: string;cashOutLkr: string;netMovementLkr: string;
  incomeEntries: number;expenseEntries: number;
};
type Breakdown = Totals & {label: string};
type Category = {
  transactionType: "INCOME"|"EXPENSE";category: string;
  totalLkr: string;entries: number;
};
interface Report {
  reportType: Period;periodStart: string;periodEnd: string;
  periodKey: string;basis: "CASH";currency: "LKR";
  totals: Totals;dailyBreakdown: Breakdown[];
  monthlyBreakdown: Breakdown[];categoryBreakdown: Category[];
  invoiceAmountsIncluded: false;reportSnapshotSaved: false;pdfGenerated: false;
  reconciledOpeningBalanceAvailable: false;
}
interface Props{businessId:string;language:Language}
const labels={
  en:{
    heading:"Cashbook reports",intro:"Daily, weekly and yearly summaries of actual cash received and paid.",
    daily:"Daily",weekly:"Weekly (Monday–Sunday)",yearly:"Yearly",
    reportDate:"Report date",year:"Report year",run:"Calculate report",busy:"Calculating...",
    cashIn:"Cash in",cashOut:"Cash out",net:"Net cash movement",
    period:"Period",incomeEntries:"Income entries",expenseEntries:"Expense entries",
    breakdown:"Period breakdown",category:"By category",noEntries:"No entries for this period.",
    export:"Download CSV",savePdf:"Save and download PDF",savingPdf:"Saving PDF...",
    pdfInfo:"PDF summary is in English only; category detail remains in the multilingual CSV.",
    caveat:"These totals represent recorded cash movements only. They are not bank-reconciled balances, taxable profit or unpaid invoice revenue.",
    exports:"CSV is a live export, not an immutable saved PDF. Existing archived PDFs remain unchanged.",
  },
  ta:{
    heading:"பணப்பதிவு அறிக்கைகள்",intro:"உண்மையில் பெற்ற, செலுத்திய பணத்திற்கான தினசரி, வாராந்த, வருடாந்த சுருக்கங்கள்.",
    daily:"தினசரி",weekly:"வாராந்த (திங்கள்–ஞாயிறு)",yearly:"வருடாந்த",
    reportDate:"அறிக்கை தேதி",year:"ஆண்டு",run:"அறிக்கை கணக்கிடு",busy:"கணக்கிடப்படுகிறது...",
    cashIn:"வரவு",cashOut:"செலவு",net:"நிகர பண மாற்றம்",
    period:"காலம்",incomeEntries:"வரவு பதிவுகள்",expenseEntries:"செலவு பதிவுகள்",
    breakdown:"காலச் சுருக்கம்",category:"வகை வாரியாக",noEntries:"இந்தக் காலத்தில் பதிவுகள் இல்லை.",
    export:"CSV பதிவிறக்கு",savePdf:"PDF சேமித்து பதிவிறக்கு",savingPdf:"PDF சேமிக்கப்படுகிறது...",
    pdfInfo:"PDF சுருக்கம் ஆங்கிலத்தில் உள்ளது; வகை விபரங்கள் CSV கோப்பில் உள்ளன.",
    caveat:"இவை பதிவு செய்யப்பட்ட பண இயக்கங்கள் மட்டுமே. வங்கி உறுதிசெய்யப்பட்ட இருப்பு, வரிக்குரிய இலாபம் அல்லது செலுத்தாத விலைப்பட்டியல் வருமானம் அல்ல.",
    exports:"CSV என்பது தற்போதைய தரவின் ஏற்றுமதி; மாற்றமில்லாத பழைய PDF அறிக்கை அல்ல.",
  },
  si:{
    heading:"මුදල් පොත් වාර්තා",intro:"සැබෑ මුදල් ලැබීම් සහ ගෙවීම් පිළිබඳ දෛනික, සතිපතා සහ වාර්ෂික සාරාංශ.",
    daily:"දෛනික",weekly:"සතිපතා (සඳුදා–ඉරිදා)",yearly:"වාර්ෂික",
    reportDate:"වාර්තා දිනය",year:"වර්ෂය",run:"වාර්තාව ගණනය කරන්න",busy:"ගණනය වෙමින්...",
    cashIn:"ලැබුණු මුදල්",cashOut:"ගෙවූ මුදල්",net:"ශුද්ධ මුදල් වෙනස",
    period:"කාලය",incomeEntries:"ආදායම් සටහන්",expenseEntries:"වියදම් සටහන්",
    breakdown:"කාල පරිච්ඡේදය",category:"වර්ග අනුව",noEntries:"මෙම කාලයේ සටහන් නැත.",
    export:"CSV බාගන්න",savePdf:"PDF සුරකින්න සහ බාගන්න",savingPdf:"PDF සුරකිමින්...",
    pdfInfo:"PDF සාරාංශය ඉංග්‍රීසි භාෂාවෙන් පමණි; වර්ග විස්තර CSV ගොනුවේ ඇත.",
    caveat:"මෙම අගයන් සටහන් කළ මුදල් චලනයන් පමණි. බැංකු ගැලපූ ශේෂය, බදු ලාභය හෝ නොගෙවූ ඉන්වොයිසි ආදායම නොවේ.",
    exports:"CSV යනු සජීවී දත්ත අපනයනයකි; සුරැකි PDF වාර්තාවක් නොවේ.",
  },
} satisfies Record<Language,Record<string,string>>;

function todayColombo():string{
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"Asia/Colombo",year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(new Date());
  const v=(x:string)=>parts.find(p=>p.type===x)?.value??"";
  return v("year")+"-"+v("month")+"-"+v("day");
}
function mondayOf(day:string):string{
  const d=new Date(day+"T00:00:00.000Z");
  if(!Number.isFinite(d.getTime()))return day;
  const difference=(d.getUTCDay()+6)%7;
  d.setUTCDate(d.getUTCDate()-difference);
  return d.toISOString().slice(0,10);
}
function money(value:string):string{
  const number=Number(value);
  return Number.isFinite(number)
    ?new Intl.NumberFormat("en-LK",{style:"currency",currency:"LKR"}).format(number)
    :value;
}
/** Escape all CSV formula characters, including leading whitespace. */
function csvField(value:string):string{
  const safe=/^[\s]*[=+@-]/.test(value)?"'"+value:value;
  return '"'+safe.replaceAll('"','""')+'"';
}
function saveCsv(report:Report):void{
  const rows:string[][]=[
    ["Noteto","Cashbook report",report.reportType,report.periodKey],
    ["Period",report.periodStart,report.periodEnd],
    ["Basis","CASH","Currency","LKR"],
    ["Total","Cash in","Cash out","Net movement","Income entries","Expense entries"],
    ["Summary",report.totals.cashInLkr,report.totals.cashOutLkr,
      report.totals.netMovementLkr,String(report.totals.incomeEntries),
      String(report.totals.expenseEntries)],
    [],
    ["Date / Month","Cash in LKR","Cash out LKR","Net movement LKR","Income entries","Expense entries"],
    ...[...report.dailyBreakdown,...report.monthlyBreakdown].map(r=>[
      r.label,r.cashInLkr,r.cashOutLkr,r.netMovementLkr,
      String(r.incomeEntries),String(r.expenseEntries),
    ]),
    [],
    ["Type","Category","Total LKR","Entry count"],
    ...report.categoryBreakdown.map(c=>[
      c.transactionType,c.category,c.totalLkr,String(c.entries),
    ]),
    [],
    ["Note","Live cashbook export only. Unpaid invoices excluded. Not bank reconciled."],
  ];
  const csv="\uFEFF"+rows.map(row=>row.map(csvField).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  const anchor=document.createElement("a");
  anchor.href=url;
  anchor.download="noteto-cashbook-"+report.reportType.toLowerCase()+
    "-"+report.periodKey+".csv";
  document.body.append(anchor);anchor.click();anchor.remove();
  URL.revokeObjectURL(url);
}
export default function CashbookReportsPanel({businessId,language}:Props){
  const t=labels[language];
  const [period,setPeriod]=useState<Period>("DAILY");
  const [date,setDate]=useState(todayColombo);
  const [year,setYear]=useState(()=>todayColombo().slice(0,4));
  const [result,setResult]=useState<Report|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [savingPdf,setSavingPdf]=useState(false);
  const [snapshotKey,setSnapshotKey]=useState(()=>crypto.randomUUID());
  const run=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();
    if(busy)return;
    setBusy(true);setError("");setResult(null);
    const key=period==="YEARLY"?year:
      period==="WEEKLY"?mondayOf(date):date;
    const query=new URLSearchParams({period,periodKey:key});
    try{
      const response=await fetch(
        "/api/reports/businesses/"+encodeURIComponent(businessId)+
        "/preview?"+query.toString(),{credentials:"include",cache:"no-store"}
      );
      const body=await response.json() as {
        success?:boolean;code?:string;report?:Report;
      };
      if(!response.ok || !body.success || !body.report ||
         body.report.basis!=="CASH" || body.report.invoiceAmountsIncluded!==false ||
         body.report.reportSnapshotSaved!==false || body.report.pdfGenerated!==false){
        throw new Error(body.code??"REPORT_NOT_AVAILABLE");
      }
      setResult(body.report);
    }catch(e){setError(e instanceof Error?e.message:"REPORT_NOT_AVAILABLE");}
    finally{setBusy(false);}
  };
  const savePdf=async()=>{
    if(!result||savingPdf||busy)return;
    setSavingPdf(true);setError("");
    const snapshotId=snapshotKey;
    const endpoint="/api/reports/businesses/"+encodeURIComponent(businessId);
    try{
      const response=await fetch(endpoint+"/snapshots",{
        method:"POST",credentials:"include",cache:"no-store",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          snapshotId,period:result.reportType,periodKey:result.periodKey,
        }),
      });
      const data=await response.json() as {
        success?:boolean;code?:string;snapshot?:{id:string};
      };
      if(!response.ok||!data.success||data.snapshot?.id!==snapshotId){
        throw new Error(data.code??"REPORT_PDF_SAVE_FAILED");
      }
      const download=await fetch(endpoint+"/snapshots/"+snapshotId+"/pdf",{
        credentials:"include",cache:"no-store",
      });
      if(!download.ok || !download.headers.get("Content-Type")?.includes("application/pdf")){
        const body=await download.json().catch(()=>null) as {code?:string}|null;
        throw new Error(body?.code??"REPORT_PDF_DOWNLOAD_FAILED");
      }
      const bytes=await download.blob();
      const objectUrl=URL.createObjectURL(bytes);
      const anchor=document.createElement("a");
      anchor.href=objectUrl;
      anchor.download="noteto-"+result.reportType.toLowerCase()+
        "-"+result.periodKey+"-saved.pdf";
      document.body.append(anchor);anchor.click();anchor.remove();
      // Preserve the snapshot key until both save and download have succeeded.
      setSnapshotKey(crypto.randomUUID());
      setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
    }catch(e){
      setError(e instanceof Error?e.message:"REPORT_PDF_SAVE_FAILED");
    }finally{setSavingPdf(false);}
  };
  const breakdown=result?[...result.dailyBreakdown,...result.monthlyBreakdown]:[];
  return <section className="noteto-cash-reports" aria-label={t.heading}>
    <header>
      <h2>{t.heading}</h2>
      <p>{t.intro}</p>
    </header>
    <form className="reports-controls" onSubmit={e=>void run(e)}>
      <div role="group" className="report-periods" aria-label={t.period}>
        {(["DAILY","WEEKLY","YEARLY"] as const).map(value=>
          <button key={value} type="button" aria-pressed={period===value}
            className={period===value?"active":""}
            onClick={()=>{setPeriod(value);setResult(null);}}>
            {value==="DAILY"?t.daily:value==="WEEKLY"?t.weekly:t.yearly}
          </button>
        )}
      </div>
      {period==="YEARLY"?
        <label>{t.year}
          <input type="number" min="2000" max={todayColombo().slice(0,4)}
            required value={year} onChange={e=>setYear(e.target.value)}/>
        </label>:
        <label>{t.reportDate}
          <input type="date" required max={todayColombo()} value={date}
            onChange={e=>setDate(e.target.value)}/>
        </label>}
      <button className="primary-button" type="submit" disabled={busy}>
        {busy?t.busy:t.run}
      </button>
    </form>
    {error&&<p className="cashbook-error" role="alert">{error}</p>}
    {result&&<>
      <p className="reports-period">{result.periodStart} — {result.periodEnd}</p>
      <div className="report-metrics">
        <div><span>{t.cashIn}</span><strong>{money(result.totals.cashInLkr)}</strong></div>
        <div><span>{t.cashOut}</span><strong>{money(result.totals.cashOutLkr)}</strong></div>
        <div><span>{t.net}</span><strong>{money(result.totals.netMovementLkr)}</strong></div>
      </div>
      <p className="report-footnote">{t.caveat}</p>
      <h3>{t.breakdown}</h3>
      <div className="report-table-scroll">
        <table><thead><tr><th>{t.period}</th><th>{t.cashIn}</th>
          <th>{t.cashOut}</th><th>{t.net}</th></tr></thead>
          <tbody>{breakdown.map(row=><tr key={row.label}>
            <td>{row.label}</td><td>{money(row.cashInLkr)}</td>
            <td>{money(row.cashOutLkr)}</td><td>{money(row.netMovementLkr)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <h3>{t.category}</h3>
      {result.categoryBreakdown.length===0?<p>{t.noEntries}</p>:
        <div className="report-table-scroll"><table>
          <thead><tr><th>{t.category}</th><th>{t.cashIn} / {t.cashOut}</th>
            <th>{t.incomeEntries} / {t.expenseEntries}</th></tr></thead>
          <tbody>{result.categoryBreakdown.map((c,i)=><tr key={i}>
            <td>{c.category}</td><td>{c.transactionType}: {money(c.totalLkr)}</td>
            <td>{c.entries}</td>
          </tr>)}</tbody>
        </table></div>}
      <div className="report-download-actions">
        <button type="button" className="secondary-button"
          onClick={()=>saveCsv(result)}>{t.export}</button>
        <button type="button" className="secondary-button"
          disabled={savingPdf||busy} onClick={()=>void savePdf()}>
          {savingPdf?t.savingPdf:t.savePdf}
        </button>
      </div>
      <p className="report-footnote">{t.pdfInfo}</p>
      <p className="report-footnote">{t.exports}</p>
    </>}
  </section>;
}
