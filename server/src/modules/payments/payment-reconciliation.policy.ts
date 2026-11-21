import type {
  PaymentInitiationRecoveryCandidate,
} from "./payment-reconciliation.repository";

export type RecoveryAction =
  | "MANUAL_MOCK_REVIEW"
  | "VERIFY_WITH_PROVIDER"
  | "ESCALATE_DATA_INCONSISTENCY";

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;

  // Recovery decisions never authorize automatic retries.
  automaticGatewayRetryAllowed: false;
  automaticPaymentUpdateAllowed: false;
}

function createDecision(
  action: RecoveryAction,
  reason: string
): RecoveryDecision {
  return {
    action,
    reason,
    automaticGatewayRetryAllowed: false,
    automaticPaymentUpdateAllowed: false,
  };
}

/**
 * Pure, read-only reconciliation policy.
 *
 * This function:
 * - Does not call a payment gateway.
 * - Does not modify the database.
 * - Does not retry payment initiation.
 * - Does not mark a payment as successful or failed.
 *
 * Provider verification must be implemented separately
 * using independently authenticated gateway evidence.
 */
export function decidePaymentInitiationRecovery(
  candidate: PaymentInitiationRecoveryCandidate
): RecoveryDecision {
  if (
    candidate.checkout_status !== "PROCESSING"
  ) {
    return createDecision(
      "ESCALATE_DATA_INCONSISTENCY",
      "CHECKOUT_NOT_PROCESSING"
    );
  }

  if (
    candidate.payment_gateway_order_id !== null ||
    candidate.checkout_gateway_order_id !== null
  ) {
    return createDecision(
      "ESCALATE_DATA_INCONSISTENCY",
      "UNEXPECTED_GATEWAY_ORDER_ID"
    );
  }

  if (
    typeof candidate.merchant_reference !== "string" ||
    !candidate.merchant_reference ||
    candidate.merchant_reference.trim() !==
      candidate.merchant_reference ||
    candidate.merchant_reference.length > 191
  ) {
    return createDecision(
      "ESCALATE_DATA_INCONSISTENCY",
      "INVALID_MERCHANT_REFERENCE"
    );
  }

  const isUnknown =
    candidate.recovery_reason === "UNKNOWN" &&
    candidate.initiation_status === "UNKNOWN";

  const isStale =
    candidate.recovery_reason === "STALE_INITIATING" &&
    candidate.initiation_status === "INITIATING" &&
    candidate.initiation_started_at !== null &&
    candidate.age_seconds !== null &&
    Number.isFinite(Number(candidate.age_seconds)) &&
    Number(candidate.age_seconds) >= 300;

  const isMissingStart =
    candidate.recovery_reason === "MISSING_START_TIME" &&
    candidate.initiation_status === "INITIATING" &&
    candidate.initiation_started_at === null;

  if (!isUnknown && !isStale && !isMissingStart) {
    return createDecision(
      "ESCALATE_DATA_INCONSISTENCY",
      "INVALID_RECOVERY_CLASSIFICATION"
    );
  }

  if (candidate.gateway === "MOCK") {
    return createDecision(
      "MANUAL_MOCK_REVIEW",
      "MOCK_GATEWAY_REQUIRES_REVIEW"
    );
  }

  if (candidate.gateway === "COMMERCIAL_BANK") {
    return createDecision(
      "VERIFY_WITH_PROVIDER",
      "INDEPENDENT_PROVIDER_EVIDENCE_REQUIRED"
    );
  }

  return createDecision(
    "ESCALATE_DATA_INCONSISTENCY",
    "UNSUPPORTED_GATEWAY"
  );
}