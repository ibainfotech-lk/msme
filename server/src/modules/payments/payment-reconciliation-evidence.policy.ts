export type EvidenceGateway = "MOCK" | "COMMERCIAL_BANK";

export type EvidenceOutcome =
  | "PENDING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "NOT_FOUND"
  | "INCONCLUSIVE";

export type EvidenceSource =
  | "PROVIDER_STATUS_QUERY"
  | "WEBHOOK_REPORT"
  | "MANUAL_BANK_RECORD";

export interface ExpectedPaymentEvidence {
  paymentId: string;
  businessId: string;
  checkoutOrderId: string;
  gateway: EvidenceGateway;
  merchantReference: string;
  amountLkr: string;
  currency: "LKR";
}

export interface ReportedPaymentEvidence {
  // This describes a claimed source, not authenticated proof.
  source: EvidenceSource;
  sourceReference: string;
  observedAt: string;

  gateway: EvidenceGateway;
  businessId: string;
  checkoutOrderId: string;
  merchantReference: string;

  amountLkr: string;
  currency: string;

  gatewayOrderId: string | null;
  gatewayTransactionId: string | null;
  outcome: EvidenceOutcome;
}

export type EvidenceClassification =
  | "MATCHED_FOR_REVIEW"
  | "INCONCLUSIVE"
  | "ESCALATE";

export interface EvidenceAssessment {
  classification: EvidenceClassification;
  reason: string;

  // No automatic action may result from this policy.
  automaticGatewayRetryAllowed: false;
  automaticPaymentUpdateAllowed: false;
  automaticSubscriptionActivationAllowed: false;
}

function assess(
  classification: EvidenceClassification,
  reason: string
): EvidenceAssessment {
  return {
    classification,
    reason,
    automaticGatewayRetryAllowed: false,
    automaticPaymentUpdateAllowed: false,
    automaticSubscriptionActivationAllowed: false,
  };
}

function validReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 191 &&
    value.trim() === value
  );
}

function validAmount(value: unknown): value is string {
  if (typeof value !== "string") return false;

  if (!/^(0|[1-9]\d{0,11})\.\d{2}$/.test(value)) {
    return false;
  }

  return value !== "0.00";
}

/**
 * Compare reported reconciliation evidence against
 * authoritative payment identifiers supplied internally.
 *
 * IMPORTANT:
 * This is a data consistency assessment only.
 *
 * It does NOT authenticate a provider response, verify
 * a webhook signature, approve a payment, authorize a
 * retry, or activate a subscription.
 */
export function assessPaymentReconciliationEvidence(
  expected: ExpectedPaymentEvidence,
  reported: ReportedPaymentEvidence
): EvidenceAssessment {
  if (
    !validReference(expected.paymentId) ||
    !validReference(expected.businessId) ||
    !validReference(expected.checkoutOrderId) ||
    !validReference(expected.merchantReference) ||
    !validAmount(expected.amountLkr) ||
    expected.currency !== "LKR" ||
    !["MOCK", "COMMERCIAL_BANK"].includes(expected.gateway)
  ) {
    return assess(
      "ESCALATE",
      "INVALID_EXPECTED_PAYMENT_RECORD"
    );
  }

  if (
    ![
      "PROVIDER_STATUS_QUERY",
      "WEBHOOK_REPORT",
      "MANUAL_BANK_RECORD",
    ].includes(reported.source) ||
    !validReference(reported.sourceReference) ||
    typeof reported.observedAt !== "string" ||
    !reported.observedAt.trim() ||
    !Number.isFinite(Date.parse(reported.observedAt))
  ) {
    return assess(
      "ESCALATE",
      "INVALID_EVIDENCE_PROVENANCE"
    );
  }

  if (
    reported.gateway !== expected.gateway ||
    reported.businessId !== expected.businessId ||
    reported.checkoutOrderId !== expected.checkoutOrderId ||
    reported.merchantReference !== expected.merchantReference ||
    reported.currency !== expected.currency ||
    !validAmount(reported.amountLkr) ||
    reported.amountLkr !== expected.amountLkr
  ) {
    return assess(
      "ESCALATE",
      "PAYMENT_EVIDENCE_MISMATCH"
    );
  }

  if (
    ![
      "PENDING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "NOT_FOUND",
      "INCONCLUSIVE",
    ].includes(reported.outcome)
  ) {
    return assess(
      "ESCALATE",
      "INVALID_EVIDENCE_OUTCOME"
    );
  }

  // A 'not found' response does NOT prove that the
  // bank did not process or charge a payment.
  if (
    reported.outcome === "NOT_FOUND" ||
    reported.outcome === "INCONCLUSIVE"
  ) {
    return assess(
      "INCONCLUSIVE",
      "PROVIDER_OUTCOME_UNRESOLVED"
    );
  }

  if (!validReference(reported.gatewayOrderId)) {
    return assess(
      "INCONCLUSIVE",
      "GATEWAY_ORDER_ID_REQUIRED"
    );
  }

  if (
    reported.gatewayTransactionId !== null &&
    !validReference(reported.gatewayTransactionId)
  ) {
    return assess(
      "ESCALATE",
      "INVALID_GATEWAY_TRANSACTION_ID"
    );
  }

  if (
    reported.outcome === "SUCCEEDED" &&
    !validReference(reported.gatewayTransactionId)
  ) {
    return assess(
      "INCONCLUSIVE",
      "SUCCESS_TRANSACTION_ID_REQUIRED"
    );
  }

  return assess(
    "MATCHED_FOR_REVIEW",
    "REPORTED_FIELDS_MATCH_EXPECTED_PAYMENT"
  );
}