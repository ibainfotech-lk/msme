/**
 * F.17.4g prospective evidence binding and invalidation policy.
 * PURE function only: no HTTP, MySQL, files, permission grants or tax outcomes.
 * Never use this policy as standalone authorization, or accept snapshots from clients.
 */
export type ReviewInvalidationCause =
  | "DRAFT_UPDATED" | "EVIDENCE_CHANGED" | "LEGAL_SOURCE_SUPERSEDED"
  | "REVIEWER_GRANT_REVOKED" | "APPROVER_GRANT_REVOKED"
  | "PROFESSIONAL_CREDENTIAL_REVOKED" | "TAXPAYER_IDENTITY_CHANGED"
  | "CASHBOOK_CORRECTED" | "CONSENT_WITHDRAWN" | "DECISION_REVOKED";
export type EvidenceReadinessReason =
  | "CONDITIONS_MET_NOT_AUTHORIZED" | "FEATURE_DISABLED"
  | "INCOMPLETE_OR_INVALID_CONTEXT" | "UNTRUSTED_EVIDENCE"
  | "CONSENT_OR_RETENTION_BLOCKED" | "STALE_REVIEW_BINDINGS"
  | "INVALID_EVENT_HISTORY" | "REVIEW_INVALIDATED";
export interface EvidenceReadinessResult {
  disposition:"CONDITIONS_MET_NOT_AUTHORIZED"|"RE_REVIEW_REQUIRED";
  reason:EvidenceReadinessReason;
  grantsAuthorization:false;
  professionalVerificationGranted:false;
  taxCalculationEnabled:false;
  taxableIncomeLkr:null;
  taxPayableLkr:null;
  paymentDueLkr:null;
}
export interface ReviewFingerprint {
  businessId:string;
  assessmentYearStart:number;
  draftId:string;
  draftRevision:number;
  claimsSha256:string;
  evidenceSetSha256:string;
  legalSourcesSha256:string;
}
export interface ReviewDecisionBinding extends ReviewFingerprint {
  decisionId:string;
  decisionStatus:"INDEPENDENTLY_REVIEWED"|"REJECTED"|"REVOKED";
  decisionRecordedAtEpochMs:number;
}
export interface EvidenceCurrentSnapshot extends ReviewFingerprint {
  /** Derived from independently checked evidence storage, not from user input. */
  evidenceReferencesIntegrityVerified:boolean;
  legalSourcesStillReviewed:boolean;
  professionalGrantStillCurrent:boolean;
  professionalCredentialStillValid:boolean;
  conflictsStillClear:boolean;
  /** Must represent consent specific to the review purpose and scope. */
  reviewConsentValid:boolean;
  reviewConsentExpiresAtEpochMs:number;
  retentionPolicyApproved:boolean;
  retentionPolicyStillApplicable:boolean;
}
export interface ReviewInvalidationEvent {
  eventId:string;
  decisionId:string;
  businessId:string;
  assessmentYearStart:number;
  cause:ReviewInvalidationCause;
  recordedAtEpochMs:number;
}
export interface ReviewEvidenceFacts {
  environment:"development"|"test"|"production";
  featureEnabled:boolean;
  nowEpochMs:number; // server clock, never client time
  decision:ReviewDecisionBinding|null;
  current:EvidenceCurrentSnapshot|null;
  /** Future read transaction must establish an authoritative, complete list. */
  invalidationHistoryComplete:boolean;
  invalidations:ReviewInvalidationEvent[]|null;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[a-f0-9]{64}$/i;
const causes:ReadonlySet<string>=new Set<ReviewInvalidationCause>([
  "DRAFT_UPDATED","EVIDENCE_CHANGED","LEGAL_SOURCE_SUPERSEDED",
  "REVIEWER_GRANT_REVOKED","APPROVER_GRANT_REVOKED",
  "PROFESSIONAL_CREDENTIAL_REVOKED","TAXPAYER_IDENTITY_CHANGED",
  "CASHBOOK_CORRECTED","CONSENT_WITHDRAWN","DECISION_REVOKED",
]);
const timestamp=(v:unknown):v is number=>
  typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
function fingerprintValid(f:ReviewFingerprint):boolean {
  return uuid.test(f.businessId)&&uuid.test(f.draftId)&&
    Number.isSafeInteger(f.assessmentYearStart)&&f.assessmentYearStart>=2025&&
    Number.isSafeInteger(f.draftRevision)&&f.draftRevision>=1&&
    hash.test(f.claimsSha256)&&hash.test(f.evidenceSetSha256)&&
    hash.test(f.legalSourcesSha256);
}
function blocked(reason:Exclude<EvidenceReadinessReason,"CONDITIONS_MET_NOT_AUTHORIZED">):
EvidenceReadinessResult{
  return {
    disposition:"RE_REVIEW_REQUIRED",reason,
    grantsAuthorization:false,professionalVerificationGranted:false,
    taxCalculationEnabled:false,
    taxableIncomeLkr:null,taxPayableLkr:null,paymentDueLkr:null,
  };
}
const conditionsOnly:EvidenceReadinessResult={
  disposition:"CONDITIONS_MET_NOT_AUTHORIZED",
  reason:"CONDITIONS_MET_NOT_AUTHORIZED",
  grantsAuthorization:false,professionalVerificationGranted:false,
  taxCalculationEnabled:false,
  taxableIncomeLkr:null,taxPayableLkr:null,paymentDueLkr:null,
};
/**
 * Re-evaluates *hypothetical* evidence state. For a real service, independently
 * verify reviewer authorization (F17.4f), current business/subscription/HOLD,
 * cryptographic source evidence and complete event history in the same locked
 * DB transaction. This function does none of that and can never approve taxes.
 */
export function evaluateReviewEvidenceState(
  facts:Partial<ReviewEvidenceFacts>|null|undefined
):EvidenceReadinessResult {
  if(!facts||facts.environment!=="development"||facts.featureEnabled!==true){
    return blocked("FEATURE_DISABLED");
  }
  const {decision,current,nowEpochMs,invalidations,invalidationHistoryComplete}=facts;
  if(!timestamp(nowEpochMs)||!decision||!current||
     !fingerprintValid(decision)||!fingerprintValid(current)||
     !uuid.test(decision.decisionId)||!timestamp(decision.decisionRecordedAtEpochMs)||
     decision.decisionRecordedAtEpochMs>nowEpochMs||
     !["INDEPENDENTLY_REVIEWED","REJECTED","REVOKED"].includes(decision.decisionStatus)){
    return blocked("INCOMPLETE_OR_INVALID_CONTEXT");
  }
  if(decision.decisionStatus!=="INDEPENDENTLY_REVIEWED"){
    return blocked("REVIEW_INVALIDATED");
  }
  if(decision.businessId!==current.businessId||
     decision.assessmentYearStart!==current.assessmentYearStart||
     decision.draftId!==current.draftId||
     decision.draftRevision!==current.draftRevision||
     decision.claimsSha256!==current.claimsSha256||
     decision.evidenceSetSha256!==current.evidenceSetSha256||
     decision.legalSourcesSha256!==current.legalSourcesSha256){
    return blocked("STALE_REVIEW_BINDINGS");
  }
  if(current.evidenceReferencesIntegrityVerified!==true||
     current.legalSourcesStillReviewed!==true||
     current.professionalGrantStillCurrent!==true||
     current.professionalCredentialStillValid!==true||
     current.conflictsStillClear!==true){
    return blocked("UNTRUSTED_EVIDENCE");
  }
  if(current.reviewConsentValid!==true||
     !timestamp(current.reviewConsentExpiresAtEpochMs)||
     nowEpochMs>=current.reviewConsentExpiresAtEpochMs||
     current.retentionPolicyApproved!==true||
     current.retentionPolicyStillApplicable!==true){
    return blocked("CONSENT_OR_RETENTION_BLOCKED");
  }
  if(invalidationHistoryComplete!==true||!Array.isArray(invalidations)){
    return blocked("INVALID_EVENT_HISTORY");
  }
  for(const event of invalidations){
    if(!event||!uuid.test(event.eventId)||!uuid.test(event.decisionId)||
       !uuid.test(event.businessId)||
       !Number.isSafeInteger(event.assessmentYearStart)||
       !timestamp(event.recordedAtEpochMs)||event.recordedAtEpochMs>nowEpochMs||
       typeof event.cause!=="string"||!causes.has(event.cause)||
       event.decisionId!==decision.decisionId||
       event.businessId!==decision.businessId||
       event.assessmentYearStart!==decision.assessmentYearStart){
      return blocked("INVALID_EVENT_HISTORY");
    }
  }
  if(invalidations.length!==0){
    return blocked("REVIEW_INVALIDATED");
  }
  // Even a fully matched case never implies live authorization or tax approval.
  return {...conditionsOnly};
}
