import type { TaxIntakeClaims, TaxIntakeDraftResult } from "./taxpayer-intake-draft.service";

/**
 * F.17.4d: an information-gathering checklist, NOT reviewer authorization.
 * Even fully answered self-declarations remain unverified. No external
 * information, taxpayer documents, rates, or tax amounts are inferred.
 */
export const taxReviewChecklistKeys = [
  "taxpayerCategoryClaim",
  "residencyClaim",
  "ownerIsTaxpayerClaim",
  "otherIncomeClaim",
  "capitalAssetsClaim",
  "nonDeductibleCostsClaim",
  "withholdingCreditsClaim",
] as const satisfies ReadonlyArray<keyof TaxIntakeClaims>;

export type TaxReviewChecklistKey = typeof taxReviewChecklistKeys[number];
export type TaxReviewChecklistState =
  "ANSWER_MISSING" | "SELF_DECLARED_UNVERIFIED";
export interface TaxReviewChecklistItem {
  key:TaxReviewChecklistKey;
  state:TaxReviewChecklistState;
  needsTaxProfessionalReview:true;
  claimIsVerification:false;
}
export interface TaxReviewChecklist {
  status:"PROFESSIONAL_REVIEW_PENDING";
  assessmentYear:string;
  draftRevision:number|null;
  answersProvided:number;
  answersMissing:number;
  items:TaxReviewChecklistItem[];
  allDeclarationsRecorded:boolean;
  allDeclarationsVerified:false;
  eligibilityVerified:false;
  reviewedStatutoryRulesApprovedForTaxpayer:false;
  taxCalculationEnabled:false;
  taxableIncomeLkr:null;
  taxPayableLkr:null;
  paymentDueLkr:null;
  financialAdjustmentsCollected:false;
  sourceEvidenceCollected:false;
}

function answerProvided(value:string|undefined):boolean {
  return value!==undefined && value!=="UNKNOWN" && value!=="NOT_SURE";
}

/**
 * Must only be called with a result returned by readTaxIntakeDraft, which
 * already applies business-scoped taxes.read, current subscription and HOLD
 * checks. This pure function cannot grant any permission.
 */
export function buildTaxReviewChecklist(
  draft:TaxIntakeDraftResult
):TaxReviewChecklist {
  const items=taxReviewChecklistKeys.map((key):TaxReviewChecklistItem=>({
    key,
    state:answerProvided(draft.claims?.[key])
      ?"SELF_DECLARED_UNVERIFIED":"ANSWER_MISSING",
    needsTaxProfessionalReview:true,
    claimIsVerification:false,
  }));
  const answersProvided=items.filter(x=>x.state==="SELF_DECLARED_UNVERIFIED").length;
  return {
    status:"PROFESSIONAL_REVIEW_PENDING",
    assessmentYear:draft.assessmentYear,
    draftRevision:draft.revision,
    answersProvided,
    answersMissing:items.length-answersProvided,
    items,
    allDeclarationsRecorded:answersProvided===items.length,
    allDeclarationsVerified:false,
    eligibilityVerified:false,
    reviewedStatutoryRulesApprovedForTaxpayer:false,
    taxCalculationEnabled:false,
    taxableIncomeLkr:null,
    taxPayableLkr:null,
    paymentDueLkr:null,
    financialAdjustmentsCollected:false,
    sourceEvidenceCollected:false,
  };
}
