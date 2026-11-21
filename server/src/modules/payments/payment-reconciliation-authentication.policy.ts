import {
  assessPaymentReconciliationEvidence,
  type ExpectedPaymentEvidence,
  type ReportedPaymentEvidence,
  type EvidenceClassification,
} from "./payment-reconciliation-evidence.policy";

export type AuthenticationBlockReason =
  | "EVIDENCE_INCONSISTENT"
  | "EVIDENCE_INCONCLUSIVE"
  | "MANUAL_RECORD_NOT_AUTHENTICATED"
  | "MOCK_EVIDENCE_NOT_AUTHENTICATED"
  | "BANK_AUTHENTICATOR_NOT_CONFIGURED";

export interface AuthenticationGateDecision {
  status: "BLOCKED";
  reason: AuthenticationBlockReason;
  evidenceClassification: EvidenceClassification;

  // The gate cannot authorize financial actions.
  trustedEvidenceAvailable: false;
  automaticGatewayRetryAllowed: false;
  automaticPaymentUpdateAllowed: false;
  automaticSubscriptionActivationAllowed: false;
}

function blocked(
  reason: AuthenticationBlockReason,
  evidenceClassification: EvidenceClassification
): AuthenticationGateDecision {
  return {
    status: "BLOCKED",
    reason,
    evidenceClassification,
    trustedEvidenceAvailable: false,
    automaticGatewayRetryAllowed: false,
    automaticPaymentUpdateAllowed: false,
    automaticSubscriptionActivationAllowed: false,
  };
}

/**
 * DEVELOPMENT TRUST BOUNDARY — FAIL CLOSED.
 *
 * A matching report is not an authenticated report.
 *
 * This function never:
 * - verifies a bank response;
 * - accepts a webhook as authenticated;
 * - changes a payment;
 * - retries initiation;
 * - activates a subscription.
 *
 * A future Commercial Bank integration must authenticate
 * server-to-server responses or webhook signatures using
 * the bank's confirmed technical specification.
 *
 * Do not replace these safeguards with a caller-supplied
 * isVerified boolean or a value from an HTTP request body.
 */
export function checkReconciliationAuthenticationGate(
  expected: ExpectedPaymentEvidence,
  reported: ReportedPaymentEvidence
): AuthenticationGateDecision {
  const assessment = assessPaymentReconciliationEvidence(
    expected,
    reported
  );

  if (assessment.classification === "ESCALATE") {
    return blocked(
      "EVIDENCE_INCONSISTENT",
      assessment.classification
    );
  }

  if (assessment.classification === "INCONCLUSIVE") {
    return blocked(
      "EVIDENCE_INCONCLUSIVE",
      assessment.classification
    );
  }

  if (reported.source === "MANUAL_BANK_RECORD") {
    return blocked(
      "MANUAL_RECORD_NOT_AUTHENTICATED",
      assessment.classification
    );
  }

  if (reported.gateway === "MOCK") {
    return blocked(
      "MOCK_EVIDENCE_NOT_AUTHENTICATED",
      assessment.classification
    );
  }

  // A genuine authenticated adapter is not configured.
  // Field matching alone must never unlock payment updates.
  return blocked(
    "BANK_AUTHENTICATOR_NOT_CONFIGURED",
    assessment.classification
  );
}