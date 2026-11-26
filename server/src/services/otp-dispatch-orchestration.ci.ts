/**
 * F.17.5j — Disposable-CI-only, injected OTP dispatch orchestration.
 *
 * This exercise intentionally does NOT connect to auth.routes, OTP creation,
 * HTTP fetch, real e-SMS credentials, staging/production startup, or SMS jobs.
 * It uses the F.17.5i journal for an irreversible send-claim BEFORE invoking
 * a synthetic injected send port.
 *
 * A provider ACCEPTED acknowledgement is not delivery or OTP verification.
 * Replays, uncertain outcomes, crashes and journal errors MUST NEVER trigger
 * an automatic resend. Current NOTETO sender approval is pending.
 */
import type {EsmsSandboxSendResult} from "./esms-sandbox-transport";
import {
  reserveOtpDispatch,
  claimOtpDispatchAttempt,
  recordOtpDispatchAcknowledgement,
  type ReserveDispatchInput,
} from "./otp-dispatch-journal.service";

export interface SyntheticOtpSendPort {
  /** Tests inject only an in-memory function. NEVER inject live fetch. */
  send(input: {
    phoneE164:string;
    message:string;
    syntheticRecipientAuthorized:boolean;
  }):Promise<EsmsSandboxSendResult>;
}
export type SyntheticDispatchOutcome =
  | "CI_DISABLED" | "REPLAY_NO_SEND"
  | "PROVIDER_ACCEPTED_NOT_DELIVERED"
  | "RECONCILIATION_REQUIRED";
export interface SyntheticDispatchResult {
  outcome:SyntheticDispatchOutcome;
  dispatchId:string|null;
  /** No code, recipient, token or SMS content is ever returned. */
  providerUid:string|null;
  portInvoked:boolean;
  resendPermitted:false;
  otpVerified:false;
  sessionAuthorized:false;
  businessActivated:false;
}
const SYNTHETIC_BODY="NOTETO DISPOSABLE CI MESSAGE - NOT A VALID OTP";
function makeResult(
  outcome:SyntheticDispatchOutcome,
  dispatchId:string|null,
  providerUid:string|null,
  portInvoked:boolean,
):SyntheticDispatchResult {
  return {
    outcome,dispatchId,providerUid,portInvoked,
    resendPermitted:false,otpVerified:false,
    sessionAuthorized:false,businessActivated:false,
  };
}
function verifiedCiEnvironment():boolean {
  return process.env.NODE_ENV==="development" &&
    process.env.CI==="true" &&
    process.env.GITHUB_ACTIONS==="true" &&
    process.env.RUNNER_OS==="Linux" &&
    process.env.GITHUB_REPOSITORY==="ibainfotech-lk/msme" &&
    process.env.NOTETO_CI_DISPOSABLE_DB==="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED==="true" &&
    process.env.DB_HOST==="127.0.0.1" &&
    process.env.DB_PORT==="3307" &&
    process.env.DB_NAME==="noteto_dev" &&
    process.env.DB_USER==="noteto_services" &&
    process.env.DB_PASSWORD==="ci_dummy_unused_password" &&
    typeof process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY==="string" &&
    process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY.length>=32;
}

/**
 * Reserve -> (if newly reserved) claim -> inject synthetic port -> record
 * metadata only. The code makes no attempt to verify the caller's OTP.
 *
 * No retry loop. A claimed but unresolved send must be reconciled separately.
 * We deliberately do not expose the SMS template or OTP to callers.
 */
export async function simulateOtpDispatchOnce(
  input:ReserveDispatchInput,
  port:SyntheticOtpSendPort,
):Promise<SyntheticDispatchResult>{
  if(!verifiedCiEnvironment() || !port || typeof port.send!=="function"){
    return makeResult("CI_DISABLED",null,null,false);
  }
  // This operation checks the live hashed challenge and verifies the
  // actual disposable MySQL identity before any synthetic send.
  const reserved=await reserveOtpDispatch(input);
  if(reserved.replayed){
    return makeResult("REPLAY_NO_SEND",reserved.dispatchId,reserved.providerUid,false);
  }
  // Commit an irreversible one-attempt claim BEFORE attempting any send.
  const claimed=await claimOtpDispatchAttempt(reserved.dispatchId);
  if(claimed.status!=="DISPATCH_UNKNOWN"||claimed.attemptCount!==1){
    // Defensive; never try sending on a non-claimed status.
    return makeResult("RECONCILIATION_REQUIRED",reserved.dispatchId,null,false);
  }
  let provider:EsmsSandboxSendResult;
  try {
    provider=await port.send({
      phoneE164:input.phoneE164,
      message:SYNTHETIC_BODY,
      syntheticRecipientAuthorized:true,
    });
  }catch{
    // A transport failure may occur *after* provider acceptance. The journal
    // stays DISPATCH_UNKNOWN; never retry or reveal upstream errors.
    return makeResult("RECONCILIATION_REQUIRED",reserved.dispatchId,null,true);
  }
  if(provider.outcome!=="ACCEPTED_NOT_DELIVERED"){
    // Includes DENIED, REJECTED and transport-uncertain states.
    // Conservatively leave the committed journal claim in DISPATCH_UNKNOWN.
    return makeResult("RECONCILIATION_REQUIRED",reserved.dispatchId,null,true);
  }
  try {
    const recorded=await recordOtpDispatchAcknowledgement(
      reserved.dispatchId,provider.providerUid
    );
    if(recorded.status==="ACKNOWLEDGED" &&
       recorded.providerUid===provider.providerUid){
      return makeResult("PROVIDER_ACCEPTED_NOT_DELIVERED",
        reserved.dispatchId,recorded.providerUid,true);
    }
  }catch{
    // Receipt persistence failed or UID was already used: never repeat SMS.
  }
  return makeResult("RECONCILIATION_REQUIRED",reserved.dispatchId,null,true);
}
