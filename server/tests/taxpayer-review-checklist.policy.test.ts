import assert from "node:assert/strict";
import {test} from "node:test";
import {
  buildTaxReviewChecklist,taxReviewChecklistKeys,
} from "../src/modules/taxes/taxpayer-review-checklist.policy";
import type {
  TaxIntakeClaims,TaxIntakeDraftResult,
} from "../src/modules/taxes/taxpayer-intake-draft.service";

function draft(claims:TaxIntakeClaims|null,revision:number|null=claims?1:null):
  TaxIntakeDraftResult {
  return {
    status:claims?"UNVERIFIED_DRAFT":"NOT_STARTED",
    assessmentYear:"2026/2027",revision,claims,
    legalOrTaxProfessionalVerified:false,
    eligibilityVerified:false,taxableIncomeLkr:null,
    taxPayableLkr:null,sourceDocumentCollected:false,
  };
}
const unknown:TaxIntakeClaims={
  taxpayerCategoryClaim:"UNKNOWN",residencyClaim:"UNKNOWN",
  ownerIsTaxpayerClaim:"UNKNOWN",otherIncomeClaim:"UNKNOWN",
  capitalAssetsClaim:"UNKNOWN",nonDeductibleCostsClaim:"UNKNOWN",
  withholdingCreditsClaim:"UNKNOWN",
};
test("no submitted tax intake remains a professional-review blocker",()=>{
  const result=buildTaxReviewChecklist(draft(null));
  assert.equal(result.status,"PROFESSIONAL_REVIEW_PENDING");
  assert.equal(result.answersProvided,0);
  assert.equal(result.answersMissing,7);
  assert.equal(result.draftRevision,null);
  assert.deepEqual(result.items.map(x=>x.key),[...taxReviewChecklistKeys]);
  assert.ok(result.items.every(x=>x.state==="ANSWER_MISSING"));
  assert.equal(result.taxPayableLkr,null);
});
test("UNKNOWN and NOT_SURE are missing, YES and NO remain unverified declarations",()=>{
  const result=buildTaxReviewChecklist(draft({
    ...unknown,taxpayerCategoryClaim:"INDIVIDUAL",residencyClaim:"NOT_SURE",
    otherIncomeClaim:"YES",capitalAssetsClaim:"NO",
  },2));
  assert.equal(result.draftRevision,2);
  assert.equal(result.answersProvided,3);
  assert.equal(result.answersMissing,4);
  assert.equal(result.allDeclarationsRecorded,false);
  assert.ok(result.items.every(x=>x.needsTaxProfessionalReview));
  assert.ok(result.items.every(x=>x.claimIsVerification===false));
  assert.equal(result.allDeclarationsVerified,false);
});
test("even 7 answered declarations do not approve taxable income or reliefs",()=>{
  const result=buildTaxReviewChecklist(draft({
    taxpayerCategoryClaim:"COMPANY",residencyClaim:"RESIDENT",
    ownerIsTaxpayerClaim:"NO",otherIncomeClaim:"NO",
    capitalAssetsClaim:"NO",nonDeductibleCostsClaim:"NO",
    withholdingCreditsClaim:"NO",
  }));
  assert.equal(result.answersProvided,7);
  assert.equal(result.answersMissing,0);
  assert.equal(result.allDeclarationsRecorded,true);
  assert.equal(result.allDeclarationsVerified,false);
  assert.equal(result.eligibilityVerified,false);
  assert.equal(result.reviewedStatutoryRulesApprovedForTaxpayer,false);
  assert.equal(result.financialAdjustmentsCollected,false);
  assert.equal(result.sourceEvidenceCollected,false);
  assert.equal(result.taxCalculationEnabled,false);
  assert.equal(result.taxableIncomeLkr,null);
  assert.equal(result.taxPayableLkr,null);
  assert.equal(result.paymentDueLkr,null);
});
test("assessment year stays attached to draft, no current-year substitution",()=>{
  const result=buildTaxReviewChecklist({
    ...draft(unknown),assessmentYear:"2025/2026",
  });
  assert.equal(result.assessmentYear,"2025/2026");
});
