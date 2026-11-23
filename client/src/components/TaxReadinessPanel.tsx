import {useState} from "react";
import type {FormEvent} from "react";
import type {Language} from "../locales";
import "./TaxReadinessPanel.css";

type Kind="SOLE_PROPRIETOR"|"PRIVATE_LIMITED"|"COMMUNITY_ORGANIZATION";
interface Result{
  status:"REVIEW_REQUIRED";assessmentYear:string;
  registrationType:Kind;assessmentStart:string;assessmentEnd:string;
  movementsRecordedThrough:string;completeAssessmentYear:boolean;
  cashReceivedLkr:string;cashPaidLkr:string;cashMovementSurplusLkr:string;
  incomeEntries:number;expenseEntries:number;
  taxableIncomeLkr:null;taxPayableLkr:null;
  paymentDueLkr:null;personalReliefEligibility:"UNVERIFIED";
  invoicesWithoutVerifiedCashExcluded:true;
}
interface SourceCoverage {
  status:"NO_REVIEWED_SOURCES"|"REVIEWED_SOURCES_AVAILABLE";
  reviewRequired:true;taxPayableLkr:null;taxCalculationEnabled:false;
  taxpayerEligibilityConfirmed:false;
  documents:Array<{sourceCode:string;revision:number;taxpayerScope:string;
    sourceTitle:string;sourceUri:string;effectiveFrom:string;effectiveTo:string;
    sourceSha256:string}>;
}
interface Props{businessId:string;language:Language}
const labels={
  en:{
    title:"Income tax preparation",intro:"Review recorded cash movements for a Sri Lankan April–March assessment year.",
    year:"Assessment year",check:"View preparation summary",checking:"Checking...",
    received:"Cash received",paid:"Cash paid",surplus:"Cashbook cash surplus",
    through:"Movements through",review:"Tax review required",
    warning:"This is NOT taxable income or tax payable. Other personal income, eligible reliefs, capital expenditure and tax adjustments are not verified.",
    personal:"The individual personal-relief threshold is not automatically a business tax exemption.",
    excluded:"Unpaid invoices have not been treated as cash income.",
    noEstimate:"Tax estimate unavailable pending verified taxpayer details and approved tax rules.",
    sources:"Reviewed legal references",noSources:"No reviewed legal-source records are currently available.",
    sourcesCaution:"Reviewed documents do not confirm your tax classification, eligible reliefs or tax payable.",
    sourcesUnavailable:"Reviewed-source registry is unavailable. Tax estimate remains disabled.",
    business:"Business registration",sole:"Sole proprietor",company:"Private limited company",community:"Community organization",
  },
  ta:{
    title:"வருமானவரி தயாரிப்பு",intro:"இலங்கையின் ஏப்ரல்–மார்ச் வரி மதிப்பீட்டு ஆண்டுக்கான பணப் பதிவுகளைப் பார்வையிடவும்.",
    year:"வரி மதிப்பீட்டு ஆண்டு",check:"சுருக்கம் பார்க்க",checking:"சரிபார்க்கப்படுகிறது...",
    received:"பெற்ற பணம்",paid:"செலுத்திய பணம்",surplus:"பணப்பதிவின் நிகர மாற்றம்",
    through:"பதிவு செய்யப்பட்ட நாள் வரை",review:"வரி நிபுணர் சரிபார்ப்பு தேவை",
    warning:"இது வரிக்குரிய வருமானமோ செலுத்த வேண்டிய வரியோ அல்ல. ஏனைய தனிப்பட்ட வருமானம், வரிச் சலுகைகள், மூலதனச் செலவுகள் மற்றும் திருத்தங்கள் சரிபார்க்கப்படவில்லை.",
    personal:"தனிநபர் வரி நிவாரணத் தொகை தானாகவே ஒவ்வொரு வணிகத்திற்கும் வரி விலக்காகாது.",
    excluded:"செலுத்தப்படாத விலைப்பட்டியல்கள் பெற்ற பண வருமானமாகக் கணக்கிடப்படவில்லை.",
    noEstimate:"வரி செலுத்த வேண்டிய தொகையை கணக்கிட உறுதிப்படுத்தப்பட்ட விவரங்களும் அங்கீகரிக்கப்பட்ட வரி விதிகளும் தேவை.",
    sources:"சரிபார்க்கப்பட்ட சட்ட ஆதாரங்கள்",
    noSources:"சரிபார்க்கப்பட்ட சட்ட ஆதாரப் பதிவுகள் தற்போது இல்லை.",
    sourcesCaution:"சரிபார்க்கப்பட்ட ஆவணம் உங்கள் வரி வகை, சலுகை அல்லது செலுத்த வேண்டிய வரியை உறுதிசெய்யாது.",
    sourcesUnavailable:"சட்ட ஆதாரப் பதிவகம் கிடைக்கவில்லை. வரி கணக்கீடு முடக்கப்பட்டுள்ளது.",
    business:"வணிக பதிவு வகை",sole:"தனிநபர் வணிகம்",company:"தனியார் வரையறுக்கப்பட்ட நிறுவனம்",community:"சமூக அமைப்பு",
  },
  si:{
    title:"ආදායම් බදු සූදානම",intro:"ශ්‍රී ලංකාවේ අප්‍රේල්–මාර්තු තක්සේරු වර්ෂය සඳහා සටහන් කළ මුදල් ගනුදෙනු සමාලෝචනය කරන්න.",
    year:"තක්සේරු වර්ෂය",check:"සාරාංශය බලන්න",checking:"පරීක්ෂා කරමින්...",
    received:"ලැබුණු මුදල්",paid:"ගෙවූ මුදල්",surplus:"මුදල් පොත් ශුද්ධ වෙනස",
    through:"ගනුදෙනු සටහන් දිනය දක්වා",review:"බදු විශේෂඥ සමාලෝචනය අවශ්‍යයි",
    warning:"මෙය බදු අය කළ හැකි ආදායම හෝ ගෙවිය යුතු බද්ද නොවේ. වෙනත් ආදායම්, සහන, ප්‍රාග්ධන වියදම් සහ ගැලපීම් තහවුරු කර නැත.",
    personal:"පුද්ගලික බදු සහන සීමාව සෑම ව්‍යාපාරයකටම ස්වයංක්‍රීය බදු නිදහසක් නොවේ.",
    excluded:"නොගෙවූ ඉන්වොයිසි ලැබුණු මුදල් ලෙස ගණන්ගෙන නැත.",
    noEstimate:"තහවුරු කළ බදු තොරතුරු සහ අනුමත නීති නොමැතිව බදු ඇස්තමේන්තුවක් ලබාදිය නොහැක.",
    sources:"සමාලෝචිත නීති මූලාශ්‍ර",
    noSources:"සමාලෝචිත නීති මූලාශ්‍ර වාර්තා දැනට නොමැත.",
    sourcesCaution:"සමාලෝචිත ලේඛන මඟින් ඔබේ බදු වර්ගය, සහන හෝ ගෙවිය යුතු බද්ද තහවුරු නොවේ.",
    sourcesUnavailable:"නීති මූලාශ්‍ර ලේඛනය ලබාගත නොහැක. බදු ගණනය අක්‍රියයි.",
    business:"ව්‍යාපාර ලියාපදිංචිය",sole:"තනි හිමිකරු",company:"පෞද්ගලික සීමිත සමාගම",community:"ප්‍රජා සංවිධානය",
  },
} satisfies Record<Language,Record<string,string>>;
function currentAssessmentStart():number{
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"Asia/Colombo",year:"numeric",month:"2-digit",
  }).formatToParts(new Date());
  const y=Number(parts.find(x=>x.type==="year")?.value??"2026");
  const m=Number(parts.find(x=>x.type==="month")?.value??"11");
  return m<4?y-1:y;
}
function lkr(raw:string):string{
  const n=Number(raw);
  return Number.isFinite(n)
    ?new Intl.NumberFormat("en-LK",{style:"currency",currency:"LKR"}).format(n)
    :raw;
}
export default function TaxReadinessPanel({businessId,language}:Props){
  const t=labels[language],latest=currentAssessmentStart();
  const [year,setYear]=useState(latest);
  const [summary,setSummary]=useState<Result|null>(null);
  const [sources,setSources]=useState<SourceCoverage|null>(null);
  const [sourceWarning,setSourceWarning]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const check=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();setBusy(true);setError("");setSummary(null);
    setSources(null);setSourceWarning("");
    try{
      const query=new URLSearchParams({assessmentYearStart:String(year)});
      const response=await fetch(
        "/api/taxes/businesses/"+encodeURIComponent(businessId)+
        "/readiness?"+query.toString(),{credentials:"include",cache:"no-store"}
      );
      const body=await response.json() as {
        success?:boolean;code?:string;readiness?:Result;
      };
      if(!response.ok || !body.success || !body.readiness ||
         body.readiness.status!=="REVIEW_REQUIRED" ||
         body.readiness.taxableIncomeLkr!==null ||
         body.readiness.taxPayableLkr!==null ||
         body.readiness.paymentDueLkr!==null){
        throw new Error(body.code??"TAX_READINESS_UNAVAILABLE");
      }
      setSummary(body.readiness);
      try{
        const sourcesResponse=await fetch(
          "/api/taxes/businesses/"+encodeURIComponent(businessId)+
          "/sources?"+query.toString(),{credentials:"include",cache:"no-store"}
        );
        const sourceBody=await sourcesResponse.json() as {
          success?:boolean;coverage?:SourceCoverage;
        };
        if(!sourcesResponse.ok||!sourceBody.success||!sourceBody.coverage||
           sourceBody.coverage.taxPayableLkr!==null ||
           sourceBody.coverage.taxCalculationEnabled!==false ||
           sourceBody.coverage.taxpayerEligibilityConfirmed!==false){
          throw new Error("SOURCE_COVERAGE_UNAVAILABLE");
        }
        setSources(sourceBody.coverage);
      }catch{setSourceWarning(t.sourcesUnavailable);}
    }catch(e){setError(e instanceof Error?e.message:"TAX_READINESS_UNAVAILABLE");}
    finally{setBusy(false);}
  };
  return <section className="noteto-tax-ready">
    <header><h2>{t.title}</h2><p>{t.intro}</p></header>
    <form className="tax-ready-controls" onSubmit={e=>void check(e)}>
      <label>{t.year}
        <select value={year} onChange={e=>setYear(Number(e.target.value))}>
          {Array.from({length:Math.max(0,latest-2025+1)},(_,i)=>latest-i)
            .map(n=><option value={n} key={n}>{n}/{n+1}</option>)}
        </select>
      </label>
      <button className="primary-button" type="submit" disabled={busy}>
        {busy?t.checking:t.check}
      </button>
    </form>
    {error&&<p className="cashbook-error" role="alert">{error}</p>}
    {summary&&<>
      <h3>{t.review}: {summary.assessmentYear}</h3>
      <p>{t.business}: {{
        SOLE_PROPRIETOR:t.sole,PRIVATE_LIMITED:t.company,
        COMMUNITY_ORGANIZATION:t.community,
      }[summary.registrationType]}</p>
      <p>{t.through}: {summary.movementsRecordedThrough}</p>
      <div className="tax-ready-metrics">
        <div><span>{t.received}</span><strong>{lkr(summary.cashReceivedLkr)}</strong></div>
        <div><span>{t.paid}</span><strong>{lkr(summary.cashPaidLkr)}</strong></div>
        <div><span>{t.surplus}</span><strong>{lkr(summary.cashMovementSurplusLkr)}</strong></div>
      </div>
      <p className="tax-ready-warning">{t.warning}</p>
      <p className="tax-ready-warning">{t.personal}</p>
      <p>{t.excluded}</p>
      <strong>{t.noEstimate}</strong>
      <div className="tax-source-references">
        <h3>{t.sources}</h3>
        <p>{t.sourcesCaution}</p>
        {sourceWarning&&<p role="status">{sourceWarning}</p>}
        {sources&&sources.documents.length===0&&<p>{t.noSources}</p>}
        {sources&&sources.documents.length>0&&<ul>
          {sources.documents.map((source,index)=><li key={source.sourceCode+source.revision+index}>
            <a href={source.sourceUri} target="_blank" rel="noopener noreferrer">
              {source.sourceTitle}
            </a>
            <small>{source.taxpayerScope} · {source.effectiveFrom} — {source.effectiveTo}</small>
          </li>)}
        </ul>}
      </div>
    </>}
  </section>;
}
