/**
 * F.17.5f supplement — e-SMS offline status lookup and reconciliation model.
 * Official contract: GET https://e-sms.lk/api/v3/sms/{uid}.
 *
 * No fetch, credentials, storage, real SMS, OTP verification or routes.
 * Caller-supplied expected facts are test data here. A real service MUST
 * retrieve the UID, recipient, tenant, sender and original dispatch binding
 * from trusted database rows, not from user/browser parameters.
 */
export const ESMS_STATUS_BASE = "https://e-sms.lk/api/v3/sms/" as const;

export type EsmsStatus =
  | "Scheduled" | "Pending" | "Queued" | "Sent"
  | "Delivered" | "Undelivered" | "Failed" | "Rejected" | "Expired";

export type EsmsStatusOutcome =
  | "IN_TRANSIT" | "DELIVERED_NOT_VERIFIED"
  | "FINAL_DELIVERY_FAILURE" | "RECONCILIATION_REQUIRED";

export interface EsmsStatusAssessment {
  outcome: EsmsStatusOutcome;
  providerStatus: EsmsStatus | null;
  reason:
    | "VALID_STATUS" | "UNTRUSTED_OR_MISMATCHED_STATUS"
    | "PROVIDER_STATUS_UNKNOWN" | "PROVIDER_LOOKUP_UNCERTAIN";
  /**
   * Delivery status is not proof of OTP possession or login.
   * Never auto-resend from this assessment; investigate the existing UID.
   */
  permitsAutomaticResend: false;
  otpVerified: false;
  sessionAuthorized: false;
  businessActivated: false;
}

export interface EsmsStatusQuery {
  url: string;
  method: "GET";
  headers: Readonly<{ Accept: "application/json" }>;
  transportEnabled: false;
}

const validUid = /^[A-Za-z0-9_-]{8,128}$/;
const validRecipient = /^947[0-9]{8}$/;
const validSender = /^[A-Za-z0-9]{1,11}$/;
const inTransit = new Set<EsmsStatus>(["Scheduled", "Pending", "Queued", "Sent"]);
const finalFailures = new Set<EsmsStatus>(["Undelivered", "Failed", "Rejected", "Expired"]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function prepareEsmsStatusQuery(uid: string): EsmsStatusQuery {
  if (typeof uid !== "string" || !validUid.test(uid)) {
    throw new Error("ESMS_INVALID_MESSAGE_UID");
  }
  return {
    url: ESMS_STATUS_BASE + uid,
    method: "GET",
    headers: {Accept: "application/json"},
    transportEnabled: false,
  };
}

function assessment(
  outcome: EsmsStatusOutcome,
  reason: EsmsStatusAssessment["reason"],
  providerStatus: EsmsStatus | null = null,
): EsmsStatusAssessment {
  return {
    outcome, reason, providerStatus,
    permitsAutomaticResend: false,
    otpVerified: false,
    sessionAuthorized: false,
    businessActivated: false,
  };
}

/**
 * Response parser for synthetic GET /sms/{uid} provider JSON.
 * Requires exact binding to originally stored server-side UID,
 * recipient and approved sender; never returns to/message content.
 *
 * No cryptographic provider authentication, signature or live request.
 * A future network adapter must authenticate HTTPS provider channel,
 * bound credential, tenant, network access and actual persisted state.
 */
export function interpretEsmsStatusResponse(
  httpStatus: number,
  payload: unknown,
  expected: { uid: string; recipient: string; senderId: string },
): EsmsStatusAssessment {
  if (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599
      || !record(expected) || typeof expected.uid !== "string" ||
      typeof expected.recipient !== "string" || typeof expected.senderId !== "string" ||
      !validUid.test(expected.uid) || !validRecipient.test(expected.recipient) ||
      !validSender.test(expected.senderId)) {
    return assessment("RECONCILIATION_REQUIRED", "UNTRUSTED_OR_MISMATCHED_STATUS");
  }
  if (httpStatus === 404 || httpStatus === 429 || httpStatus >= 500) {
    return assessment("RECONCILIATION_REQUIRED", "PROVIDER_LOOKUP_UNCERTAIN");
  }
  if (httpStatus < 200 || httpStatus >= 300 || !record(payload) ||
      payload.status !== "success" || !record(payload.data)) {
    return assessment("RECONCILIATION_REQUIRED", "UNTRUSTED_OR_MISMATCHED_STATUS");
  }
  const d=payload.data;
  if (d.uid !== expected.uid || d.to !== expected.recipient ||
      d.from !== expected.senderId || typeof d.status !== "string") {
    return assessment("RECONCILIATION_REQUIRED", "UNTRUSTED_OR_MISMATCHED_STATUS");
  }
  const status=d.status as EsmsStatus;
  if (inTransit.has(status)) return assessment("IN_TRANSIT", "VALID_STATUS", status);
  if (status === "Delivered") return assessment("DELIVERED_NOT_VERIFIED", "VALID_STATUS", status);
  if (finalFailures.has(status)) return assessment("FINAL_DELIVERY_FAILURE", "VALID_STATUS", status);
  return assessment("RECONCILIATION_REQUIRED", "PROVIDER_STATUS_UNKNOWN");
}
