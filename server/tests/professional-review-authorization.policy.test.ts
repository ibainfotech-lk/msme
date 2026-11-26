import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateProfessionalReviewPolicy,
  type ProfessionalReviewAction, type ReviewPolicyFacts,
} from "../src/modules/taxes/professional-review-authorization.policy";

const reviewer="11111111-1111-4111-8111-111111111111";
const approver="22222222-2222-4222-8222-222222222222";
const declarant="33333333-3333-4333-8333-333333333333";
const owner="44444444-4444-4444-8444-444444444444";
const issuer="55555555-5555-4555-8555-555555555555";
const tenant="66666666-6666-4666-8666-666666666666";
const otherTenant="77777777-7777-4777-8777-777777777777";
const evidence="a".repeat(64),legal="b".repeat(64);
const now=1800000000000;

function facts(action:ProfessionalReviewAction="RECOMMEND"):ReviewPolicyFacts{
  const actor=action==="RECOMMEND"?reviewer:approver;
  return {
    environment:"development",featureEnabled:true,nowEpochMs:now,
    authenticatedUserId:actor,actorUserId:actor,action,
    businessId:tenant,assessmentYearStart:2026,
    business:{id:tenant,status:"ACTIVE"},
    subscription:{
      businessId:tenant,status:"ACTIVE",
      startsAtEpochMs:now-10000,endsAtEpochMs:now+10000,heldAtEpochMs:null,
    },
    membership:{businessId:tenant,userId:actor,status:"ACTIVE"},
    credential:{
      userId:actor,professionallyVerified:true,
      independentVerificationRecorded:true,
      scopeIncludesSriLankanTax:true,expiresAtEpochMs:now+10000,
      revokedAtEpochMs:null,
    },
    grant:{
      actorUserId:actor,businessId:tenant,assessmentYearStart:2026,
      action,issuedByUserId:issuer,independentlyProvisioned:true,
      validFromEpochMs:now-10000,expiresAtEpochMs:now+10000,
      revokedAtEpochMs:null,
    },
    reviewCase:{
      businessId:tenant,assessmentYearStart:2026,draftRevision:2,
      declarantUserId:declarant,beneficialOwnerUserIds:[owner],
      evidenceSetSha256:evidence,legalSourcesSha256:legal,
    },
    recommendation:action==="INDEPENDENT_APPROVE"?{
      businessId:tenant,assessmentYearStart:2026,draftRevision:2,
      reviewerUserId:reviewer,evidenceSetSha256:evidence,
      legalSourcesSha256:legal,status:"RECOMMEND_VERIFIED",
    }:null,
  };
}

function outcome(f:ReviewPolicyFacts,reason:string){
  const result=evaluateProfessionalReviewPolicy(f);
  assert.equal(result.reason,reason);
  assert.equal(result.outcome,"DENY");
  assert.equal(result.grantsAuthorization,false);
  assert.equal(result.taxpayerVerified,false);
  assert.equal(result.taxCalculationEnabled,false);
  assert.equal(result.taxableIncomeLkr,null);
  assert.equal(result.taxPayableLkr,null);
  assert.equal(result.paymentDueLkr,null);
}
test("missing facts and production/test modes fail closed before any approval",()=>{
  assert.equal(evaluateProfessionalReviewPolicy(null).outcome,"DENY");
  for(const environment of ["production","test"] as const){
    outcome({...facts(),environment},"FEATURE_DISABLED");
  }
  outcome({...facts(),featureEnabled:false},"FEATURE_DISABLED");
});
test("policy-ready reviewer never receives live approval or a tax amount",()=>{
  const result=evaluateProfessionalReviewPolicy(facts());
  assert.equal(result.outcome,"POLICY_CONDITIONS_MET");
  assert.equal(result.grantsAuthorization,false);
  assert.equal(result.taxpayerVerified,false);
  assert.equal(result.taxCalculationEnabled,false);
  assert.equal(result.taxableIncomeLkr,null);
  assert.equal(result.taxPayableLkr,null);
  assert.equal(result.paymentDueLkr,null);
});
test("spoofed authenticated actor and unsupported years fail closed",()=>{
  outcome({...facts(),authenticatedUserId:declarant},"INVALID_CONTEXT");
  outcome({...facts(),assessmentYearStart:2024},"INVALID_CONTEXT");
  outcome({...facts(),actorUserId:"not-uuid"},"INVALID_CONTEXT");
});
test("cross-tenant and inactive account memberships are denied",()=>{
  const cross=facts();cross.membership={businessId:otherTenant,userId:reviewer,status:"ACTIVE"};
  outcome(cross,"TENANT_ACCESS_DENIED");
  const wrongBusiness=facts();wrongBusiness.business={id:otherTenant,status:"ACTIVE"};
  outcome(wrongBusiness,"TENANT_ACCESS_DENIED");
  const inactive=facts();inactive.membership!.status="REVOKED";
  outcome(inactive,"TENANT_ACCESS_DENIED");
  const suspended=facts();suspended.business!.status="SUSPENDED";
  outcome(suspended,"TENANT_ACCESS_DENIED");
});
test("held, past due, expired and not-yet-active subscriptions are denied",()=>{
  const held=facts();held.subscription!.heldAtEpochMs=now-1;
  outcome(held,"SUBSCRIPTION_NOT_ELIGIBLE");
  const pastDue=facts();pastDue.subscription!.status="PAST_DUE";
  outcome(pastDue,"SUBSCRIPTION_NOT_ELIGIBLE");
  const expired=facts();expired.subscription!.endsAtEpochMs=now;
  outcome(expired,"SUBSCRIPTION_NOT_ELIGIBLE");
  const future=facts();future.subscription!.startsAtEpochMs=now+1;
  outcome(future,"SUBSCRIPTION_NOT_ELIGIBLE");
});
test("absent or unverified professional credentials never qualify",()=>{
  const missing=facts();missing.credential=null;
  outcome(missing,"PROFESSIONAL_CREDENTIAL_NOT_VERIFIED");
  const unverified=facts();unverified.credential!.professionallyVerified=false;
  outcome(unverified,"PROFESSIONAL_CREDENTIAL_NOT_VERIFIED");
  const wrongScope=facts();wrongScope.credential!.scopeIncludesSriLankanTax=false;
  outcome(wrongScope,"PROFESSIONAL_CREDENTIAL_NOT_VERIFIED");
  const revoked=facts();revoked.credential!.revokedAtEpochMs=now-1;
  outcome(revoked,"PROFESSIONAL_CREDENTIAL_NOT_VERIFIED");
  const expired=facts();expired.credential!.expiresAtEpochMs=now;
  outcome(expired,"PROFESSIONAL_CREDENTIAL_NOT_VERIFIED");
});
test("owner and declarant cannot self-review",()=>{
  const self=facts();self.actorUserId=declarant;self.authenticatedUserId=declarant;
  self.membership!.userId=declarant;self.credential!.userId=declarant;
  self.grant!.actorUserId=declarant;
  outcome(self,"CONFLICT_OF_INTEREST");
  const ownerSelf=facts();ownerSelf.actorUserId=owner;ownerSelf.authenticatedUserId=owner;
  ownerSelf.membership!.userId=owner;ownerSelf.credential!.userId=owner;
  ownerSelf.grant!.actorUserId=owner;
  outcome(ownerSelf,"CONFLICT_OF_INTEREST");
});
test("grant cannot be inherited, cross-tenant, self-issued, expired or revoked",()=>{
  const noGrant=facts();noGrant.grant=null;
  outcome(noGrant,"REVIEW_GRANT_NOT_VALID");
  const other=facts();other.grant!.businessId=otherTenant;
  outcome(other,"REVIEW_GRANT_NOT_VALID");
  const year=facts();year.grant!.assessmentYearStart=2025;
  outcome(year,"REVIEW_GRANT_NOT_VALID");
  const self=facts();self.grant!.issuedByUserId=reviewer;
  outcome(self,"REVIEW_GRANT_NOT_VALID");
  const declarantIssued=facts();declarantIssued.grant!.issuedByUserId=declarant;
  outcome(declarantIssued,"REVIEW_GRANT_NOT_VALID");
  const unchecked=facts();unchecked.grant!.independentlyProvisioned=false;
  outcome(unchecked,"REVIEW_GRANT_NOT_VALID");
  const revoked=facts();revoked.grant!.revokedAtEpochMs=now-1;
  outcome(revoked,"REVIEW_GRANT_NOT_VALID");
  const expired=facts();expired.grant!.expiresAtEpochMs=now;
  outcome(expired,"REVIEW_GRANT_NOT_VALID");
});
test("review case must be tenant/year/revision and evidence bound",()=>{
  const missing=facts();missing.reviewCase=null;
  outcome(missing,"REVIEW_CASE_INCOMPLETE");
  const wrongYear=facts();wrongYear.reviewCase!.assessmentYearStart=2025;
  outcome(wrongYear,"REVIEW_CASE_INCOMPLETE");
  const zeroRev=facts();zeroRev.reviewCase!.draftRevision=0;
  outcome(zeroRev,"REVIEW_CASE_INCOMPLETE");
  const absentOwners=facts();absentOwners.reviewCase!.beneficialOwnerUserIds=[];
  outcome(absentOwners,"REVIEW_CASE_INCOMPLETE");
  const badHash=facts();badHash.reviewCase!.evidenceSetSha256="missing";
  outcome(badHash,"REVIEW_CASE_INCOMPLETE");
});
test("approver requires exact independently submitted recommendation",()=>{
  const valid=evaluateProfessionalReviewPolicy(facts("INDEPENDENT_APPROVE"));
  assert.equal(valid.outcome,"POLICY_CONDITIONS_MET");
  assert.equal(valid.grantsAuthorization,false);
  const absent=facts("INDEPENDENT_APPROVE");absent.recommendation=null;
  outcome(absent,"RECOMMENDATION_NOT_VALID");
  const incomplete=facts("INDEPENDENT_APPROVE");
  incomplete.recommendation!.status="NEEDS_INFORMATION";
  outcome(incomplete,"RECOMMENDATION_NOT_VALID");
  const stale=facts("INDEPENDENT_APPROVE");stale.recommendation!.draftRevision=1;
  outcome(stale,"RECOMMENDATION_NOT_VALID");
  const mismatched=facts("INDEPENDENT_APPROVE");
  mismatched.recommendation!.evidenceSetSha256="c".repeat(64);
  outcome(mismatched,"RECOMMENDATION_NOT_VALID");
  const wrongTenant=facts("INDEPENDENT_APPROVE");
  wrongTenant.recommendation!.businessId=otherTenant;
  outcome(wrongTenant,"RECOMMENDATION_NOT_VALID");
});
test("reviewer cannot approve their own recommendation",()=>{
  const self=facts("INDEPENDENT_APPROVE");
  self.recommendation!.reviewerUserId=approver;
  outcome(self,"CONFLICT_OF_INTEREST");
  const declarantReviewed=facts("INDEPENDENT_APPROVE");
  declarantReviewed.recommendation!.reviewerUserId=declarant;
  outcome(declarantReviewed,"CONFLICT_OF_INTEREST");
});
