import {useEffect,useState} from "react";
import type {Language} from "../locales";

type Field="taxpayerCategoryClaim"|"residencyClaim"|"ownerIsTaxpayerClaim"|
  "otherIncomeClaim"|"capitalAssetsClaim"|"nonDeductibleCostsClaim"|"withholdingCreditsClaim";
interface Checklist {
  status:"PROFESSIONAL_REVIEW_PENDING";
  draftRevision:number|null;
  answersProvided:number;answersMissing:number;
  allDeclarationsVerified:false;eligibilityVerified:false;
  taxableIncomeLkr:null;taxPayableLkr:null;paymentDueLkr:null;
  taxCalculationEnabled:false;
  items:Array<{key:Field;state:"ANSWER_MISSING"|"SELF_DECLARED_UNVERIFIED"}>;
}
const words={
  en:{
    heading:"Tax review checklist",summary:"Recorded answers",
    missing:"Needs an answer",declared:"Declared — not verified",
    caution:"Every answer requires independent tax-professional verification. No tax estimate or relief has been approved.",
    unavailable:"The checklist is unavailable. No tax estimate is permitted.",
    fields:["Potential taxpayer","Tax residency","Owner personally liable",
      "Other income","Capital assets","Non-deductible expenses","Withholding credits"],
  },
  ta:{
    heading:"வரி சரிபார்ப்பு பட்டியல்",summary:"பதிவு செய்யப்பட்ட பதில்கள்",
    missing:"பதில் தேவை",declared:"கூறப்பட்டுள்ளது — சரிபார்க்கவில்லை",
    caution:"ஒவ்வொரு பதிலும் வரி நிபுணரால் தனியாக சரிபார்க்கப்பட வேண்டும். வரிக் கணிப்போ சலுகையோ அங்கீகரிக்கப்படவில்லை.",
    unavailable:"சரிபார்ப்பு பட்டியல் கிடைக்கவில்லை. வரிக் கணிப்பு செய்ய முடியாது.",
    fields:["வரி செலுத்துபவர்","வரி வதிவிடம்","உரிமையாளரின் தனிப்பட்ட வரி பொறுப்பு",
      "பிற வருமானம்","மூலதனச் சொத்துகள்","வரி கழிக்க முடியாத செலவுகள்","பிடித்தம் செய்யப்பட்ட வரி"],
  },
  si:{
    heading:"බදු සමාලෝචන පිරික්සුම් ලැයිස්තුව",summary:"සටහන් කළ පිළිතුරු",
    missing:"පිළිතුරක් අවශ්‍යයි",declared:"ප්‍රකාශිතයි — තහවුරු කර නැත",
    caution:"සෑම පිළිතුරක්ම බදු විශේෂඥයෙකු විසින් වෙනම තහවුරු කළ යුතුය. බදු ඇස්තමේන්තුවක් අනුමත කර නැත.",
    unavailable:"පිරික්සුම් ලැයිස්තුව ලබාගත නොහැක. බදු ඇස්තමේන්තුවක් නොමැත.",
    fields:["බදු ගෙවන්නා","බදු පදිංචිය","හිමිකරුගේ පුද්ගලික වගකීම",
      "වෙනත් ආදායම්","ප්‍රාග්ධන වත්කම්","අඩු කළ නොහැකි වියදම්","රඳවාගත් බදු"],
  },
} satisfies Record<Language,{heading:string;summary:string;missing:string;
  declared:string;caution:string;unavailable:string;fields:string[]}>;
const keys:Field[]=[
  "taxpayerCategoryClaim","residencyClaim","ownerIsTaxpayerClaim",
  "otherIncomeClaim","capitalAssetsClaim","nonDeductibleCostsClaim",
  "withholdingCreditsClaim",
];
export default function TaxpayerReviewChecklist({businessId,year,language,refreshKey}:{
  businessId:string;year:number;language:Language;refreshKey:number;
}){
  const t=words[language];
  const [checklist,setChecklist]=useState<Checklist|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{
    let active=true;
    setChecklist(null);setError(false);
    void fetch("/api/taxes/businesses/"+encodeURIComponent(businessId)+
      "/review-checklist?assessmentYearStart="+encodeURIComponent(year),{
        credentials:"include",cache:"no-store",
      }).then(async res=>{
        const body=await res.json() as {success?:boolean;checklist?:Checklist};
        if(!res.ok||!body.success||!body.checklist||
           body.checklist.taxPayableLkr!==null||
           body.checklist.taxableIncomeLkr!==null||
           body.checklist.paymentDueLkr!==null||
           body.checklist.taxCalculationEnabled!==false||
           body.checklist.allDeclarationsVerified!==false||
           body.checklist.eligibilityVerified!==false){
          throw Error("INVALID_TAX_REVIEW_CHECKLIST");
        }
        if(active)setChecklist(body.checklist);
      }).catch(()=>{if(active)setError(true);});
    return ()=>{active=false;};
  },[businessId,year,refreshKey]);
  return <section className="tax-review-checklist" aria-label={t.heading}>
    <h4>{t.heading}</h4>
    {error&&<p role="status">{t.unavailable}</p>}
    {checklist&&<>
      <p><strong>{t.summary}: {checklist.answersProvided}/{keys.length}</strong></p>
      <ul>{keys.map((key,index)=>{
        const item=checklist.items.find(x=>x.key===key);
        return <li key={key}>
          <span>{t.fields[index]}</span>
          <small>{item?.state==="SELF_DECLARED_UNVERIFIED"?t.declared:t.missing}</small>
        </li>;
      })}</ul>
    </>}
    <p className="tax-review-disclaimer">{t.caution}</p>
  </section>;
}
