import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessOtpDispatchCandidate, assessOtpProviderReceiptCandidate,
  type OtpDispatchFacts, type OtpDeliveryReason,
  type OtpProviderReceiptFacts,
} from "../src/services/otp-delivery-contract.policy";

const now=1800000000000;
const req="11111111-1111-4111-8111-111111111111";
const challenge="22222222-2222-4222-8222-222222222222";

function context():OtpDispatchFacts {
  return {
    stage:"DISPOSABLE_CI",mode:"STUB",nowEpochMs:now,
    requestId:req,challengeId:challenge,phoneE164:"+15005550006",
    channel:"SMS",purpose:"REGISTRATION",language:"ta",
    originAndCsrfValidated:true,abuseStoreHealthy:true,
    phoneSuppressionChecked:true,requestsPerPhoneWindow:0,
    requestsPerSourceWindow:0,lastDispatchAtEpochMs:null,
    challengeIssuedAtEpochMs:now-10_000,
    challengeExpiresAtEpochMs:now+100_000,
    challengeAttempts:0,sandboxProviderApproved:false,
    providerCredentialsScoped:false,syntheticRecipientVerified:true,
  };
}
function reject(f:Partial<OtpDispatchFacts>|null,reason:OtpDeliveryReason):void{
  const x=assessOtpDispatchCandidate(f);
  assert.equal(x.outcome,"DENY");
  assert.equal(x.reason,reason);
  assert.equal(x.sendsMessage,false);
  assert.equal(x.authorizesDelivery,false);
  assert.equal(x.createsOtpChallenge,false);
  assert.equal(x.verifiesOtp,false);
  assert.equal(x.authenticatesUser,false);
  assert.equal(x.activatesBusiness,false);
}
function receipt():OtpProviderReceiptFacts{
  return {
    stage:"DISPOSABLE_CI",mode:"STUB",nowEpochMs:now,
    requestId:req,challengeId:challenge,
    providerMessageId:"synthetic_ref_001",
    providerState:"QUEUED",providerResponseAuthenticated:true,
    providerReferenceMatchesRequest:true,duplicateReceipt:false,
  };
}
function rejectReceipt(f:Partial<OtpProviderReceiptFacts>|null,reason:string):void{
  const x=assessOtpProviderReceiptCandidate(f);
  assert.equal(x.outcome,"REJECT");
  assert.equal(x.reason,reason);
  assert.equal(x.providerMessageRecorded,false);
  assert.equal(x.userVerified,false);
  assert.equal(x.sessionAuthorized,false);
  assert.equal(x.activatesBusiness,false);
}

test("missing facts and production mode fail closed before any SMS",()=>{
  reject(null,"PRODUCTION_NOT_APPROVED");
  const f=context();f.stage="PRODUCTION";f.mode="LIVE";
  reject(f,"PRODUCTION_NOT_APPROVED");
});
test("synthetic CI and independently described staging conditions never permit delivery",()=>{
  const ci=assessOtpDispatchCandidate(context());
  assert.equal(ci.outcome,"CONDITIONS_MET_NOT_AUTHORIZED");
  assert.equal(ci.sendsMessage,false);
  assert.equal(ci.authorizesDelivery,false);
  assert.equal(ci.createsOtpChallenge,false);
  assert.equal(ci.authenticatesUser,false);
  const staging=context();
  staging.stage="STAGING";staging.mode="SANDBOX";
  staging.sandboxProviderApproved=true;staging.providerCredentialsScoped=true;
  const approvedCondition=assessOtpDispatchCandidate(staging);
  assert.equal(approvedCondition.outcome,"CONDITIONS_MET_NOT_AUTHORIZED");
  assert.equal(approvedCondition.authorizesDelivery,false);
});
test("invalid request, language, channel and purpose are rejected",()=>{
  const f=context();f.requestId="bad";reject(f,"INVALID_CONTEXT");
  const g=context();g.purpose="PAYMENT" as OtpDispatchFacts["purpose"];
  reject(g,"INVALID_CONTEXT");
  const h=context();h.language="fr" as OtpDispatchFacts["language"];
  reject(h,"INVALID_CONTEXT");
  const i=context();i.channel="EMAIL" as OtpDispatchFacts["channel"];
  reject(i,"INVALID_CONTEXT");
});
test("recipient must be canonical E.164",()=>{
  for(const phone of ["0771234567","94771234567","  +94771234567",
    "+00000000000","+123","+"+"1".repeat(16)]){
    const f=context();f.phoneE164=phone;
    reject(f,"INVALID_RECIPIENT");
  }
});
test("no client flag can bypass origin, suppression or healthy abuse controls",()=>{
  const keys=[
    "originAndCsrfValidated","abuseStoreHealthy",
    "phoneSuppressionChecked","syntheticRecipientVerified",
  ] as const;
  for(const key of keys){
    const f=context();f[key]=false;
    reject(f,"UNTRUSTED_REQUEST");
  }
});
test("per-phone/per-source quotas and cooldown fail closed",()=>{
  const phone=context();phone.requestsPerPhoneWindow=3;
  reject(phone,"RATE_LIMIT_DENIED");
  const source=context();source.requestsPerSourceWindow=10;
  reject(source,"RATE_LIMIT_DENIED");
  const negative=context();negative.requestsPerPhoneWindow=-1;
  reject(negative,"RATE_LIMIT_DENIED");
  const soon=context();soon.lastDispatchAtEpochMs=now-20_000;
  reject(soon,"RATE_LIMIT_DENIED");
  const future=context();future.lastDispatchAtEpochMs=now+1;
  reject(future,"RATE_LIMIT_DENIED");
});
test("challenge must be issued already, expire within five minutes and remain retryable",()=>{
  const exp=context();exp.challengeExpiresAtEpochMs=now;
  reject(exp,"CHALLENGE_NOT_READY");
  const long=context();long.challengeExpiresAtEpochMs=now+400_000;
  reject(long,"CHALLENGE_NOT_READY");
  const notIssued=context();notIssued.challengeIssuedAtEpochMs=now+1000;
  reject(notIssued,"CHALLENGE_NOT_READY");
  const attempts=context();attempts.challengeAttempts=5;
  reject(attempts,"CHALLENGE_NOT_READY");
  const bad=context();bad.challengeAttempts=-1;
  reject(bad,"CHALLENGE_NOT_READY");
});
test("live/mixed providers, unapproved sandbox and provider credential scope are rejected",()=>{
  const prodGateway=context();prodGateway.mode="LIVE";
  reject(prodGateway,"PROVIDER_NOT_APPROVED");
  const unexpectedSandbox=context();unexpectedSandbox.mode="SANDBOX";
  reject(unexpectedSandbox,"PROVIDER_NOT_APPROVED");
  const fakeApproval=context();fakeApproval.sandboxProviderApproved=true;
  reject(fakeApproval,"PROVIDER_NOT_APPROVED");
  const staging=context();staging.stage="STAGING";staging.mode="SANDBOX";
  reject(staging,"PROVIDER_NOT_APPROVED");
  staging.sandboxProviderApproved=true;
  reject(staging,"PROVIDER_NOT_APPROVED");
});
test("valid synthetic receipt metadata is not proof of code possession",()=>{
  const x=assessOtpProviderReceiptCandidate(receipt());
  assert.equal(x.outcome,"METADATA_ACCEPTABLE_NOT_VERIFICATION");
  assert.equal(x.providerMessageRecorded,false);
  assert.equal(x.userVerified,false);
  assert.equal(x.sessionAuthorized,false);
  assert.equal(x.activatesBusiness,false);
});
test("spoofed, mismatched, duplicate, malformed or rejected provider receipts are refused",()=>{
  const missing=receipt();missing.providerMessageId="bad";
  rejectReceipt(missing,"INVALID_RECEIPT");
  const spoofed=receipt();spoofed.providerResponseAuthenticated=false;
  rejectReceipt(spoofed,"UNTRUSTED_PROVIDER_RESPONSE");
  const mismatch=receipt();mismatch.providerReferenceMatchesRequest=false;
  rejectReceipt(mismatch,"UNTRUSTED_PROVIDER_RESPONSE");
  const duplicate=receipt();duplicate.duplicateReceipt=true;
  rejectReceipt(duplicate,"UNTRUSTED_PROVIDER_RESPONSE");
  const failed=receipt();failed.providerState="REJECTED";
  rejectReceipt(failed,"PROVIDER_REJECTED");
  const prod=receipt();prod.stage="PRODUCTION";prod.mode="LIVE";
  rejectReceipt(prod,"PRODUCTION_NOT_APPROVED");
});
