import {useEffect,useState} from "react";
import type {FormEvent} from "react";
import type {Language} from "../locales";
import "./TaxpayerIntakePanel.css";
type Answer="UNKNOWN"|"YES"|"NO"|"NOT_SURE";
type Category="UNKNOWN"|"INDIVIDUAL"|"COMPANY"|"OTHER_ENTITY"|"NOT_SURE";
type Residency="UNKNOWN"|"RESIDENT"|"NON_RESIDENT"|"NOT_SURE";
interface Claims{
  taxpayerCategoryClaim:Category;
  residencyClaim:Residency;
  otherIncomeClaim:Answer;
  capitalAssetsClaim:Answer;
  nonDeductibleCostsClaim:Answer;
  withholdingCreditsClaim:Answer;
  ownerIsTaxpayerClaim:Answer;
}
interface Intake{
  status:"NOT_STARTED"|"UNVERIFIED_DRAFT";
  revision:number|null;claims:Claims|null;
  legalOrTaxProfessionalVerified:false;
  taxableIncomeLkr:null;taxPayableLkr:null;
}
interface Props{businessId:string;year:number;language:Language}
const empty:Claims={
  taxpayerCategoryClaim:"UNKNOWN",residencyClaim:"UNKNOWN",
  otherIncomeClaim:"UNKNOWN",capitalAssetsClaim:"UNKNOWN",
  nonDeductibleCostsClaim:"UNKNOWN",withholdingCreditsClaim:"UNKNOWN",
  ownerIsTaxpayerClaim:"UNKNOWN",
};
const copy={
  en:{
    title:"Tax preparation questionnaire",intro:"Save draft answers for your tax advisor. These are unverified claims, not tax calculations.",
    category:"Who may be the taxpayer?",residency:"Claimed tax residency",
    otherIncome:"Other income outside this cashbook?",
    capitalAssets:"Furniture, equipment or other capital purchases?",
    nonDeductibleCosts:"Costs that may not be tax deductible?",
    withholdingCredits:"Any tax already withheld or credited?",
    ownerIsTaxpayer:"Is the business owner personally the taxpayer?",
    save:"Save unverified draft",saving:"Saving draft...",ready:"Unverified draft saved",
    unknown:"Unknown / not checked",yes:"Yes",no:"No",notSure:"Not sure",
    individual:"Individual",company:"Company",otherEntity:"Other legal entity",
    resident:"Resident",nonResident:"Non-resident",
    notice:"No personal IDs or monetary tax amounts are collected here. A professional must verify every answer before any tax estimate.",
    denied:"Only members with taxes.manage permission can save drafts.",
  },
  ta:{
    title:"வரி தயாரிப்பு கேள்வித்தாள்",intro:"வரி ஆலோசகருக்காக சரிபார்க்கப்படாத பதில்களை வரைவாக சேமிக்கவும்.",
    category:"வரி செலுத்துபவர் யார்?",residency:"கூறப்படும் வரி வதிவிடம்",
    otherIncome:"இந்த பணப்பதிவுக்கு வெளியே வேறு வருமானம் உண்டா?",
    capitalAssets:"தளபாடம், இயந்திரம் போன்ற மூலதனக் கொள்முதல் உண்டா?",
    nonDeductibleCosts:"வரி விலக்கு பெறாத செலவுகள் இருக்கலாமா?",
    withholdingCredits:"ஏற்கெனவே பிடித்தம் செய்யப்பட்ட வரி அல்லது வரிச் சலுகை உண்டா?",
    ownerIsTaxpayer:"வணிக உரிமையாளரே தனிப்பட்ட வரி செலுத்துபவரா?",
    save:"சரிபார்க்கப்படாத வரைவைச் சேமி",saving:"சேமிக்கப்படுகிறது...",ready:"வரைவு சேமிக்கப்பட்டது",
    unknown:"தெரியாது / சரிபார்க்கவில்லை",yes:"ஆம்",no:"இல்லை",notSure:"உறுதியில்லை",
    individual:"தனிநபர்",company:"நிறுவனம்",otherEntity:"பிற சட்ட நிறுவனம்",
    resident:"வதிவாளர்",nonResident:"வதிவாளர் அல்லாதவர்",
    notice:"இங்கு அடையாள எண்களோ வரித்தொகைகளோ சேகரிக்கப்படாது. கணக்கீட்டுக்கு முன் நிபுணர் பதில்களை சரிபார்க்க வேண்டும்.",
    denied:"taxes.manage அனுமதியுள்ள உறுப்பினர்கள் மட்டுமே வரைவைச் சேமிக்கலாம்.",
  },
  si:{
    title:"බදු සූදානම් ප්‍රශ්නාවලිය",intro:"බදු උපදේශකයා සඳහා තහවුරු නොකළ පිළිතුරු කෙටුම්පතක් ලෙස සුරකින්න.",
    category:"බදු ගෙවන්නා කවුරුන්ද?",residency:"ප්‍රකාශිත බදු පදිංචිය",
    otherIncome:"මුදල් පොතෙන් පිටත වෙනත් ආදායමක් තිබේද?",
    capitalAssets:"ගෘහ භාණ්ඩ, උපකරණ හෝ ප්‍රාග්ධන මිලදී ගැනීම් තිබේද?",
    nonDeductibleCosts:"බදු අඩු නොකළ හැකි වියදම් තිබේද?",
    withholdingCredits:"රඳවාගත් බදු හෝ බදු බැර තිබේද?",
    ownerIsTaxpayer:"ව්‍යාපාර හිමියා පුද්ගලික බදු ගෙවන්නාද?",
    save:"තහවුරු නොකළ කෙටුම්පත සුරකින්න",saving:"සුරකිමින්...",ready:"කෙටුම්පත සුරැකිණි",
    unknown:"නොදනී / පරීක්ෂා කර නැත",yes:"ඔව්",no:"නැත",notSure:"විශ්වාස නැත",
    individual:"පුද්ගලයා",company:"සමාගම",otherEntity:"වෙනත් නීතිමය ආයතනය",
    resident:"පදිංචිකරු",nonResident:"අනේවාසික",
    notice:"පුද්ගලික හඳුනාගැනීමේ අංක හෝ බදු මුදල් මෙහි රැස් නොකෙරේ. බදු ඇස්තමේන්තුවකට පෙර විශේෂඥ සමාලෝචනය අවශ්‍යයි.",
    denied:"කෙටුම්පත් සුරැකීමට taxes.manage අවසරය අවශ්‍යයි.",
  },
} satisfies Record<Language,Record<string,string>>;
const fields:(keyof Claims)[]=[
  "taxpayerCategoryClaim","residencyClaim","otherIncomeClaim",
  "capitalAssetsClaim","nonDeductibleCostsClaim",
  "withholdingCreditsClaim","ownerIsTaxpayerClaim",
];
const fieldLabels:(keyof typeof copy.en)[]=[
  "category","residency","otherIncome","capitalAssets","nonDeductibleCosts",
  "withholdingCredits","ownerIsTaxpayer",
];
export default function TaxpayerIntakePanel({businessId,year,language}:Props){
  const t=copy[language];
  const [answers,setAnswers]=useState<Claims>(empty);
  const [revision,setRevision]=useState<number|null>(null);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [status,setStatus]=useState(""),[error,setError]=useState("");
  const endpoint="/api/taxes/businesses/"+encodeURIComponent(businessId)+"/intake";
  useEffect(()=>{
    let active=true;
    setLoading(true);setError("");setStatus("");setRevision(null);setAnswers(empty);
    const query=new URLSearchParams({assessmentYearStart:String(year)});
    void fetch(endpoint+"?"+query,{credentials:"include",cache:"no-store"})
      .then(async response=>{
        const body=await response.json() as {success?:boolean;code?:string;intake?:Intake};
        if(!response.ok||!body.success||!body.intake||
           body.intake.taxPayableLkr!==null ||
           body.intake.legalOrTaxProfessionalVerified!==false)
          throw Error(body.code??"TAX_INTAKE_READ_FAILED");
        if(!active)return;
        setAnswers(body.intake.claims??empty);setRevision(body.intake.revision);
      }).catch(e=>{if(active)setError(e instanceof Error?e.message:"TAX_INTAKE_READ_FAILED");})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[businessId,year,endpoint]);
  const save=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(busy||loading)return;
    setBusy(true);setStatus("");setError("");
    try{
      const response=await fetch(endpoint,{
        method:"PUT",credentials:"include",cache:"no-store",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({assessmentYearStart:year,expectedRevision:revision,claims:answers}),
      });
      const body=await response.json() as {success?:boolean;code?:string;intake?:Intake};
      if(!response.ok||!body.success||!body.intake||
         body.intake.taxPayableLkr!==null ||
         body.intake.legalOrTaxProfessionalVerified!==false ||
         body.intake.status!=="UNVERIFIED_DRAFT"){
        throw Error(body.code==="TAX_INTAKE_MANAGE_PERMISSION_DENIED"?t.denied:
          body.code??"TAX_INTAKE_SAVE_FAILED");
      }
      setRevision(body.intake.revision);setStatus(t.ready);
    }catch(e){setError(e instanceof Error?e.message:"TAX_INTAKE_SAVE_FAILED");}
    finally{setBusy(false);}
  };
  return <section className="noteto-tax-intake">
    <h3>{t.title}</h3>
    <p>{t.intro}</p>
    <form onSubmit={e=>void save(e)}>
      {fields.map((key,index)=>{
        const title=t[fieldLabels[index]];
        const options:keyof typeof copy.en=key==="taxpayerCategoryClaim"?"individual":"unknown";
        void options;
        const list=key==="taxpayerCategoryClaim"
          ?(["UNKNOWN","INDIVIDUAL","COMPANY","OTHER_ENTITY","NOT_SURE"] as const)
          :key==="residencyClaim"
            ?(["UNKNOWN","RESIDENT","NON_RESIDENT","NOT_SURE"] as const)
            :(["UNKNOWN","YES","NO","NOT_SURE"] as const);
        const labelFor=(value:string)=>({
          UNKNOWN:t.unknown,YES:t.yes,NO:t.no,NOT_SURE:t.notSure,
          INDIVIDUAL:t.individual,COMPANY:t.company,OTHER_ENTITY:t.otherEntity,
          RESIDENT:t.resident,NON_RESIDENT:t.nonResident,
        } as Record<string,string>)[value]??value;
        return <label key={key}>
          <span>{title}</span>
          <select disabled={busy||loading} value={answers[key]} onChange={e=>
            setAnswers(old=>({...old,[key]:e.target.value}) as Claims)
          }>
            {list.map(value=><option value={value} key={value}>{labelFor(value)}</option>)}
          </select>
        </label>;
      })}
      <button type="submit" className="primary-button" disabled={busy||loading}>
        {busy?t.saving:t.save}
      </button>
    </form>
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert">{error}</p>}
    <p className="tax-intake-notice">{t.notice}</p>
  </section>;
}
