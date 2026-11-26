/** F.16.5: read-only checkout recovery decisions. No payment initiation. */

export type RecoverableCheckoutStatus =
  | "PENDING" | "PROCESSING" | "PAID" | "FAILED" | "CANCELLED" | "EXPIRED";
export type PaymentAttemptStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED";
export type PaymentInitiation = "RESERVED" | "INITIATING" | "INITIATED" | "UNKNOWN" | "FAILED";

export interface RecoveryAttempt {
  status: PaymentAttemptStatus;
  initiationStatus: PaymentInitiation;
}

export interface RecoverySnapshot {
  checkoutStatus: RecoverableCheckoutStatus;
  expiresAt: Date | null;
  attempts: readonly RecoveryAttempt[];
}

export type RecoveryAction =
  | "RESUME_UNPAID_CHECKOUT"
  | "RESUME_RESERVED_ATTEMPT"
  | "EXPIRED_WITHOUT_PAYMENT"
  | "RECONCILIATION_REQUIRED"
  | "VERIFY_SETTLEMENT"
  | "NOT_RECOVERABLE";

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Only means first DB reservation is possible; NEVER authorizes a charge. */
  mayReserveFirstPaymentAttempt: boolean;
}

/**
 * All returned actions are informational; an authenticated, permission-checked,
 * transactional service must re-read and lock rows before acting on them.
 * An unknown / initiated / failed gateway attempt MUST NOT be retried blindly.
 */
export function assessCheckoutRecovery(
  snapshot: RecoverySnapshot,
  now: Date
): RecoveryDecision {
  const result = (action: RecoveryAction, mayReserveFirstPaymentAttempt = false): RecoveryDecision =>
    ({ action, mayReserveFirstPaymentAttempt });

  if (!Number.isFinite(now.getTime())) return result("RECONCILIATION_REQUIRED");
  if (snapshot.checkoutStatus === "PAID") return result("VERIFY_SETTLEMENT");
  if (snapshot.checkoutStatus === "PROCESSING") return result("RECONCILIATION_REQUIRED");
  if (snapshot.attempts.length > 1) return result("RECONCILIATION_REQUIRED");
  if (snapshot.attempts.some(a => a.status === "SUCCEEDED")) {
    return result("RECONCILIATION_REQUIRED");
  }
  if (snapshot.checkoutStatus !== "PENDING") return result("NOT_RECOVERABLE");
  if (snapshot.expiresAt === null || !Number.isFinite(snapshot.expiresAt.getTime())) {
    return result("RECONCILIATION_REQUIRED");
  }
  if (snapshot.attempts.length === 1) {
    const [attempt] = snapshot.attempts;
    if (
      attempt.status === "PENDING" &&
      attempt.initiationStatus === "RESERVED" &&
      now < snapshot.expiresAt
    ) return result("RESUME_RESERVED_ATTEMPT");
    // Even FAILED or UNKNOWN is blocked until the backend reconciles it.
    return result("RECONCILIATION_REQUIRED");
  }
  if (now >= snapshot.expiresAt) return result("EXPIRED_WITHOUT_PAYMENT");
  return result("RESUME_UNPAID_CHECKOUT", true);
}
