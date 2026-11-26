/**
 * F.17.5f — e-SMS offline contract adapter.
 *
 * Implements the provider's DOCUMENTED JSON request and response shapes.
 * No fetch, socket, token, OTP generation, database, queue, HTTP route or
 * auth/session integration. Cannot transmit an SMS or authorize login.
 * Source: https://e-sms.lk/docs (reviewed 2026-11-24).
 *
 * The credential-bearing live/sandbox transport and durable delivery outbox
 * require separately approved provider access and security review.
 */
export const ESMS_SEND_URL = "https://e-sms.lk/api/v3/sms/send" as const;

export interface EsmsPreparedOtp {
  endpoint: typeof ESMS_SEND_URL;
  method: "POST";
  headers: Readonly<{"Content-Type":"application/json";Accept:"application/json"}>;
  /** Contains a sensitive message. Never log or persist it in plaintext. */
  body: string;
  /** No request is performed or authorized by preparation. */
  transportEnabled: false;
}

export type EsmsContractResult =
  | {
      outcome: "ACCEPTED_NOT_DELIVERED";
      providerUid: string;
      permitsOtpVerification: false;
      userAuthenticated: false;
      businessActivated: false;
    }
  | {
      outcome: "REJECTED" | "RECONCILIATION_REQUIRED";
      reason: "PROVIDER_DECLINED" | "PROVIDER_RESPONSE_UNTRUSTED" |
        "PROVIDER_STATE_UNCERTAIN";
      permitsOtpVerification: false;
      userAuthenticated: false;
      businessActivated: false;
    };

const localMobile = /^\+947[0-9]{8}$/;
const senderName = /^[A-Za-z0-9]{1,11}$/;
const uidPattern = /^[A-Za-z0-9_-]{8,128}$/;
// Documented terminal error classes. All other failures are treated as
// uncertain because automated retries could send duplicate OTP messages.
const terminalProviderCodes = new Set([
  "UNAUTHENTICATED", "INSUFFICIENT_CREDITS", "SENDER_NOT_APPROVED",
  "SENDER_NOT_ACTIVE", "NO_RECIPIENTS", "ALL_BLOCKED", "TOO_MANY",
  "EMPTY_MESSAGE", "BAD_SCHEDULE", "GROUP_NOT_FOUND",
  "EMPTY_GROUP", "BLACKOUT", "NOT_FOUND",
]);
const maxMessageLength = 300;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pure serialization only. No Authorization header or credential is created.
 * Only a single canonical Sri Lankan mobile number is permitted (not bulk).
 * e-SMS accepts 947xxxxxxxx; the Noteto account remains +947xxxxxxxx.
 */
export function prepareEsmsOtpRequest(input:{
  phoneE164:string;
  senderId:string;
  message:string;
}):EsmsPreparedOtp {
  if (typeof input?.phoneE164!=="string" || !localMobile.test(input.phoneE164)) {
    throw new Error("ESMS_INVALID_RECIPIENT");
  }
  if (typeof input.senderId!=="string" || !senderName.test(input.senderId)) {
    throw new Error("ESMS_INVALID_SENDER_NAME");
  }
  if (typeof input.message!=="string" || !input.message.trim() ||
      input.message.length>maxMessageLength ||
      /[\u0000-\u001f\u007f]/.test(input.message)) {
    throw new Error("ESMS_INVALID_MESSAGE");
  }
  return {
    endpoint:ESMS_SEND_URL,
    method:"POST",
    headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({
      recipient:input.phoneE164.slice(1),
      sender_id:input.senderId,
      message:input.message,
    }),
    transportEnabled:false,
  };
}

function declined():EsmsContractResult {
  return {outcome:"REJECTED",reason:"PROVIDER_DECLINED",
    permitsOtpVerification:false,userAuthenticated:false,businessActivated:false};
}
function uncertain(reason:"PROVIDER_RESPONSE_UNTRUSTED"|"PROVIDER_STATE_UNCERTAIN"):
EsmsContractResult {
  return {outcome:"RECONCILIATION_REQUIRED",reason,
    permitsOtpVerification:false,userAuthenticated:false,businessActivated:false};
}

/**
 * Pure interpretation of an injected JSON fixture. A provider response
 * does NOT verify code possession and is not independently authenticated
 * by this function. Never treat ACCEPTED as an actual delivery receipt.
 *
 * Do not immediately retry on unknown status, timeouts, 429 or 5xx;
 * first reconcile the provider UID/status or obtain manual review.
 */
export function interpretEsmsSendResponse(
  httpStatus:number, payload:unknown
):EsmsContractResult {
  if(!Number.isSafeInteger(httpStatus)||httpStatus<100||httpStatus>599 ||
     !isRecord(payload)) {
    return uncertain("PROVIDER_RESPONSE_UNTRUSTED");
  }
  if(payload.status==="success") {
    if(httpStatus<200||httpStatus>299 || !isRecord(payload.data) ||
       typeof payload.data.uid!=="string"||
       !uidPattern.test(payload.data.uid)) {
      return uncertain("PROVIDER_RESPONSE_UNTRUSTED");
    }
    return {
      outcome:"ACCEPTED_NOT_DELIVERED",providerUid:payload.data.uid,
      permitsOtpVerification:false,userAuthenticated:false,businessActivated:false,
    };
  }
  if(payload.status==="error") {
    if(httpStatus>=200&&httpStatus<=299 || typeof payload.code!=="string") {
      return uncertain("PROVIDER_RESPONSE_UNTRUSTED");
    }
    if(httpStatus===429 || httpStatus>=500) {
      return uncertain("PROVIDER_STATE_UNCERTAIN");
    }
    // Reject with no automatic retry; do not expose provider error text
    // which may contain phone numbers, message text or authentication details.
    if(terminalProviderCodes.has(payload.code)) return declined();
    return uncertain("PROVIDER_STATE_UNCERTAIN");
  }
  return uncertain("PROVIDER_RESPONSE_UNTRUSTED");
}
