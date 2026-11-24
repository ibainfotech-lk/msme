import assert from "node:assert/strict";
import {test} from "node:test";
import {
  evaluateReviewEvidenceState,
  type ReviewEvidenceFacts,
  type EvidenceReadinessReason,
  type ReviewInvalidationCause,
} from "../src/modules/taxes/review-evidence-invalidation.policy";

const businessId="11111111-1111-4111-8111-111111111111";
const draftId="22222222-2222-4222-8222-222222222222";
const decisionId="33333333-3333-4333-8333-333333333333";
const eventId="44444444-4444-4444-8444-444444444444";
const otherBusiness="55555555-5555-4555-8555-555555555555";
const now=1800000000000;
function facts():ReviewEvidenceFacts{
  const fingerprint={
    businessId,assessmentYearStart:2026,draftId,draftRevision:3,
    claimsSha256:"a".repeat(64),
    evidenceSetSha256:"b".repeat(64),
    legalSourcesSha256:"c".repeat(64),
  };
  return {
    environment:"development",featureEnabled:true,nowEpochMs:now,
    decision:{
      ...fingerprint,decisionId,decisionStatus:"INDEPENDENTLY_REVIEWED",
      decisionRecordedAtEpochMs:now-100000,
    },
    current:{
      ...fingerprint,evidenceReferencesIntegrityVerified:true,
      legalSourcesStillReviewed:true,professionalGrantStillCurrent:true,
      professionalCredentialStillValid:true,conflictsStillClear:true,
      reviewConsentValid:true,reviewConsentExpiresAtEpochMs:now+100000,
      retentionPolicyApproved:true,retentionPolicyStillApplicable:true,
    },
    invalidationHistoryComplete:true,invalidations:[],
  };
}
function deny(f:Partial<ReviewEvidenceFacts>|null,expected:EvidenceReadinessReason){
  const r=evaluateReviewEvidenceState(f);
  assert.equal(r.disposition,"RE_REVIEW_REQUIRED");
  assert.equal(r.reason,expected);
  assert.equal(r.grantsAuthorization,false);
  assert.equal(r.professionalVerificationGranted,false);
  assert.equal(r.taxCalculationEnabled,false);
  assert.equal(r.taxableIncomeLkr,null);
  assert.equal(r.taxPayableLkr,null);
  assert.equal(r.paymentDueLkr,null);
}
function event(f:ReviewEvidenceFacts,cause:ReviewInvalidationCause){
  f.invalidations=[{
    eventId,decisionId,businessId,assessmentYearStart:2026,
    cause,recordedAtEpochMs:now-500,
  }];
}
test("missing snapshots, production, tests and disabled flag never qualify",()=>{
  deny(null,"FEATURE_DISABLED");
  const production=facts();production.environment="production";
  deny(production,"FEATURE_DISABLED");
  const testEnvironment=facts();testEnvironment.environment="test";
  deny(testEnvironment,"FEATURE_DISABLED");
  const off=facts();off.featureEnabled=false;deny(off,"FEATURE_DISABLED");
  const missing=facts();missing.current=null;
  deny(missing,"INCOMPLETE_OR_INVALID_CONTEXT");
});
test("bound snapshots are only policy conditions, never tax approval",()=>{
  const r=evaluateReviewEvidenceState(facts());
  assert.equal(r.disposition,"CONDITIONS_MET_NOT_AUTHORIZED");
  assert.equal(r.reason,"CONDITIONS_MET_NOT_AUTHORIZED");
  assert.equal(r.grantsAuthorization,false);
  assert.equal(r.professionalVerificationGranted,false);
  assert.equal(r.taxCalculationEnabled,false);
  assert.equal(r.taxableIncomeLkr,null);
  assert.equal(r.taxPayableLkr,null);
  assert.equal(r.paymentDueLkr,null);
});
test("only well-formed historical decision identifiers, revisions and digests qualify",()=>{
  const invalid=facts();invalid.decision!.decisionId="bad";
  deny(invalid,"INCOMPLETE_OR_INVALID_CONTEXT");
  const negative=facts();negative.current!.draftRevision=0;
  deny(negative,"INCOMPLETE_OR_INVALID_CONTEXT");
  const emptyHash=facts();emptyHash.current!.evidenceSetSha256="";
  deny(emptyHash,"INCOMPLETE_OR_INVALID_CONTEXT");
  const future=facts();future.decision!.decisionRecordedAtEpochMs=now+10;
  deny(future,"INCOMPLETE_OR_INVALID_CONTEXT");
});
test("changed assessment year, business, draft ID/revision or any digest invalidates",()=>{
  const changes:Array<(f:ReviewEvidenceFacts)=>void>=[
    f=>{f.current!.assessmentYearStart=2025;},
    f=>{f.current!.businessId=otherBusiness;},
    f=>{f.current!.draftId="66666666-6666-4666-8666-666666666666";},
    f=>{f.current!.draftRevision=4;},
    f=>{f.current!.claimsSha256="d".repeat(64);},
    f=>{f.current!.evidenceSetSha256="e".repeat(64);},
    f=>{f.current!.legalSourcesSha256="f".repeat(64);},
  ];
  for(const change of changes){
    const f=facts();change(f);
    deny(f,"STALE_REVIEW_BINDINGS");
  }
});
test("rejected and revoked decisions cannot be reused",()=>{
  const rejected=facts();rejected.decision!.decisionStatus="REJECTED";
  deny(rejected,"REVIEW_INVALIDATED");
  const revoked=facts();revoked.decision!.decisionStatus="REVOKED";
  deny(revoked,"REVIEW_INVALIDATED");
});
test("evidence, grants, credentials and conflict checks all fail closed",()=>{
  const flags=[
    "evidenceReferencesIntegrityVerified","legalSourcesStillReviewed",
    "professionalGrantStillCurrent","professionalCredentialStillValid",
    "conflictsStillClear",
  ] as const;
  for(const flag of flags){
    const f=facts();f.current![flag]=false;
    deny(f,"UNTRUSTED_EVIDENCE");
  }
});
test("missing, expired or withdrawn consent and retention policies block",()=>{
  const noConsent=facts();noConsent.current!.reviewConsentValid=false;
  deny(noConsent,"CONSENT_OR_RETENTION_BLOCKED");
  const expired=facts();expired.current!.reviewConsentExpiresAtEpochMs=now;
  deny(expired,"CONSENT_OR_RETENTION_BLOCKED");
  const notApproved=facts();notApproved.current!.retentionPolicyApproved=false;
  deny(notApproved,"CONSENT_OR_RETENTION_BLOCKED");
  const noLongerValid=facts();noLongerValid.current!.retentionPolicyStillApplicable=false;
  deny(noLongerValid,"CONSENT_OR_RETENTION_BLOCKED");
});
test("missing event stream or untrusted events fail closed",()=>{
  const noHistory=facts();noHistory.invalidationHistoryComplete=false;
  deny(noHistory,"INVALID_EVENT_HISTORY");
  const noEvents=facts();noEvents.invalidations=null;
  deny(noEvents,"INVALID_EVENT_HISTORY");
  const wrongTenant=facts();event(wrongTenant,"DRAFT_UPDATED");
  wrongTenant.invalidations![0].businessId=otherBusiness;
  deny(wrongTenant,"INVALID_EVENT_HISTORY");
  const forged=facts();event(forged,"CONSENT_WITHDRAWN");
  forged.invalidations![0].eventId="not-uuid";
  deny(forged,"INVALID_EVENT_HISTORY");
  const futureEvent=facts();event(futureEvent,"DECISION_REVOKED");
  futureEvent.invalidations![0].recordedAtEpochMs=now+1;
  deny(futureEvent,"INVALID_EVENT_HISTORY");
});
test("every documented change event forces new independent review",()=>{
  const causes:ReviewInvalidationCause[]=[
    "DRAFT_UPDATED","EVIDENCE_CHANGED","LEGAL_SOURCE_SUPERSEDED",
    "REVIEWER_GRANT_REVOKED","APPROVER_GRANT_REVOKED",
    "PROFESSIONAL_CREDENTIAL_REVOKED","TAXPAYER_IDENTITY_CHANGED",
    "CASHBOOK_CORRECTED","CONSENT_WITHDRAWN","DECISION_REVOKED",
  ];
  for(const cause of causes){
    const f=facts();event(f,cause);
    deny(f,"REVIEW_INVALIDATED");
  }
});
