/**
 * F.17.5d — Provider-neutral OTP delivery CONTRACT + PURE security preflight.
 *
 * NOT connected to auth.routes, otp.service, a provider or a database.
 * Neither function sends SMS, creates/consumes an OTP challenge, checks a real
 * provider signature, logs phone/code values, or grants authentication.
 * All facts are hypothetical future SERVER-derived input, never client proof.
 */
export type OtpDeliveryStage = "LOCAL_DEV" | "DISPOSABLE_CI" | "STAGING" | "PRODUCTION";
export type OtpDeliveryMode = "DISABLED" | "STUB" | "SANDBOX" | "LIVE";
export type OtpDeliveryReason =
  | "CONDITIONS_MET_NOT_AUTHORIZED" | "PRODUCTION_NOT_APPROVED"
  | "INVALID_CONTEXT" | "INVALID_RECIPIENT"
  | "UNTRUSTED_REQUEST" | "RATE_LIMIT_DENIED"
  | "CHALLENGE_NOT_READY" | "PROVIDER_NOT_APPROVED";
export interface OtpDeliveryAssessment {
  outcome: "DENY" | "CONDITIONS_MET_NOT_AUTHORIZED";
  reason: OtpDeliveryReason;
  /** Always false. A true policy predicate is NOT an actual send permit. */
  sendsMessage: false;
  authorizesDelivery: false;
  createsOtpChallenge: false;
  verifiesOtp: false;
  authenticatesUser: false;
  activatesBusiness: false;
}
export interface OtpDispatchFacts {
  stage: OtpDeliveryStage;
  mode: OtpDeliveryMode;
  nowEpochMs: number;
  requestId: string;
  challengeId: string;
  /** E.164 number, used only for format checking; never returned or logged. */
  phoneE164: string;
  channel: "SMS";
  purpose: "LOGIN" | "REGISTRATION";
  language: "en" | "ta" | "si";
  /** Derived by future trusted service from authenticated origin / CSRF. */
  originAndCsrfValidated: boolean;
  abuseStoreHealthy: boolean;
  phoneSuppressionChecked: boolean;
  requestsPerPhoneWindow: number;
  requestsPerSourceWindow: number;
  lastDispatchAtEpochMs: number | null;
  challengeIssuedAtEpochMs: number;
  challengeExpiresAtEpochMs: number;
  challengeAttempts: number;
  /** Provider agreements / credentials must be reviewed before sandbox use. */
  sandboxProviderApproved: boolean;
  providerCredentialsScoped: boolean;
  /** True only for future synthetic test identities proven by a trusted runner. */
  syntheticRecipientVerified: boolean;
}
export interface OtpProviderReceiptFacts {
  stage: OtpDeliveryStage;
  mode: OtpDeliveryMode;
  nowEpochMs: number;
  requestId: string;
  challengeId: string;
  /** Provider opaque reference only, never a phone, OTP, access token or URL. */
  providerMessageId: string;
  providerState: "QUEUED" | "ACCEPTED" | "REJECTED" | "UNKNOWN";
  providerResponseAuthenticated: boolean;
  providerReferenceMatchesRequest: boolean;
  duplicateReceipt: boolean;
}
export interface OtpReceiptAssessment {
  outcome: "REJECT" | "METADATA_ACCEPTABLE_NOT_VERIFICATION";
  reason: "PRODUCTION_NOT_APPROVED" | "INVALID_RECEIPT" |
    "UNTRUSTED_PROVIDER_RESPONSE" | "PROVIDER_REJECTED" |
    "METADATA_ACCEPTABLE_NOT_VERIFICATION";
  providerMessageRecorded: false;
  userVerified: false;
  sessionAuthorized: false;
  activatesBusiness: false;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const e164 = /^\+[1-9]\d{7,14}$/;
const number = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function denial(reason: Exclude<OtpDeliveryReason, "CONDITIONS_MET_NOT_AUTHORIZED">):
OtpDeliveryAssessment {
  return {
    outcome:"DENY",reason,
    sendsMessage:false,authorizesDelivery:false,createsOtpChallenge:false,
    verifiesOtp:false,authenticatesUser:false,activatesBusiness:false,
  };
}
const conditions: OtpDeliveryAssessment = {
  outcome:"CONDITIONS_MET_NOT_AUTHORIZED",
  reason:"CONDITIONS_MET_NOT_AUTHORIZED",
  sendsMessage:false,authorizesDelivery:false,createsOtpChallenge:false,
  verifiesOtp:false,authenticatesUser:false,activatesBusiness:false,
};
const MAX_OTP_AGE_MS=5*60*1000;
const MIN_COOLDOWN_MS=30*1000;
const MAX_PHONE_REQUESTS_PER_WINDOW=3;
const MAX_SOURCE_REQUESTS_PER_WINDOW=10;
const MAX_CHALLENGE_ATTEMPTS=5;

/**
 * No HTTP request, user-agent, browser flag or process.env is consulted.
 * A future endpoint MUST obtain counters, timestamps, identities and scope
 * from a trusted server-side store and enforce quotas atomically.
 */
export function assessOtpDispatchCandidate(
  facts: Partial<OtpDispatchFacts> | null | undefined
): OtpDeliveryAssessment {
  if(!facts || facts.stage==="PRODUCTION"){
    return denial("PRODUCTION_NOT_APPROVED");
  }
  const {stage,mode,nowEpochMs:now,requestId,challengeId,phoneE164,
    channel,purpose,language,originAndCsrfValidated,abuseStoreHealthy,
    phoneSuppressionChecked,requestsPerPhoneWindow,requestsPerSourceWindow,
    lastDispatchAtEpochMs,challengeIssuedAtEpochMs,challengeExpiresAtEpochMs,
    challengeAttempts,sandboxProviderApproved,providerCredentialsScoped,
    syntheticRecipientVerified}=facts;
  if(!["LOCAL_DEV","DISPOSABLE_CI","STAGING"].includes(stage as string) ||
     !uuid.test(requestId ?? "") || !uuid.test(challengeId ?? "") ||
     !number(now) || channel!=="SMS" ||
     !["LOGIN","REGISTRATION"].includes(purpose as string) ||
     !["en","ta","si"].includes(language as string)){
    return denial("INVALID_CONTEXT");
  }
  if(typeof phoneE164!=="string" || !e164.test(phoneE164)){
    return denial("INVALID_RECIPIENT");
  }
  if(originAndCsrfValidated!==true||abuseStoreHealthy!==true||
     phoneSuppressionChecked!==true||syntheticRecipientVerified!==true){
    return denial("UNTRUSTED_REQUEST");
  }
  if(!number(requestsPerPhoneWindow)||!number(requestsPerSourceWindow)||
     requestsPerPhoneWindow>=MAX_PHONE_REQUESTS_PER_WINDOW||
     requestsPerSourceWindow>=MAX_SOURCE_REQUESTS_PER_WINDOW||
     !(lastDispatchAtEpochMs===null || number(lastDispatchAtEpochMs)) ||
     (typeof lastDispatchAtEpochMs==="number" &&
       (lastDispatchAtEpochMs>now! || now!-lastDispatchAtEpochMs<MIN_COOLDOWN_MS))){
    return denial("RATE_LIMIT_DENIED");
  }
  if(!number(challengeIssuedAtEpochMs)||!number(challengeExpiresAtEpochMs)||
     !number(challengeAttempts) || challengeAttempts>=MAX_CHALLENGE_ATTEMPTS||
     challengeIssuedAtEpochMs>now! || challengeExpiresAtEpochMs<=now! ||
     challengeExpiresAtEpochMs-challengeIssuedAtEpochMs>MAX_OTP_AGE_MS){
    return denial("CHALLENGE_NOT_READY");
  }
  if((stage==="LOCAL_DEV"||stage==="DISPOSABLE_CI")
       ? mode!=="STUB" || sandboxProviderApproved!==false
       : mode!=="SANDBOX" || sandboxProviderApproved!==true ||
         providerCredentialsScoped!==true){
    return denial("PROVIDER_NOT_APPROVED");
  }
  // Passing a synthetic preflight never permits an OTP to be sent.
  return {...conditions};
}

/**
 * Even an authentic "QUEUED"/"ACCEPTED" provider acknowledgement is
 * not evidence of OTP possession, user authentication, or actual delivery.
 */
export function assessOtpProviderReceiptCandidate(
  facts: Partial<OtpProviderReceiptFacts> | null | undefined
): OtpReceiptAssessment {
  let reason: OtpReceiptAssessment["reason"];
  if(!facts || facts.stage==="PRODUCTION") {
    reason="PRODUCTION_NOT_APPROVED";
  }else if(!["LOCAL_DEV","DISPOSABLE_CI","STAGING"].includes(facts.stage as string) ||
     (facts.stage==="STAGING" ? facts.mode!=="SANDBOX" : facts.mode!=="STUB") ||
     !number(facts.nowEpochMs)||!uuid.test(facts.requestId??"")||
     !uuid.test(facts.challengeId??"")||
     typeof facts.providerMessageId!=="string" ||
     !/^[A-Za-z0-9_-]{8,128}$/.test(facts.providerMessageId)){
    reason="INVALID_RECEIPT";
  }else if(facts.providerResponseAuthenticated!==true||
     facts.providerReferenceMatchesRequest!==true||facts.duplicateReceipt!==false){
    reason="UNTRUSTED_PROVIDER_RESPONSE";
  }else if(facts.providerState!=="QUEUED"&&facts.providerState!=="ACCEPTED"){
    reason="PROVIDER_REJECTED";
  }else{
    reason="METADATA_ACCEPTABLE_NOT_VERIFICATION";
  }
  return {
    outcome:reason==="METADATA_ACCEPTABLE_NOT_VERIFICATION"
      ?"METADATA_ACCEPTABLE_NOT_VERIFICATION":"REJECT",
    reason,providerMessageRecorded:false,userVerified:false,
    sessionAuthorized:false,activatesBusiness:false,
  };
}
