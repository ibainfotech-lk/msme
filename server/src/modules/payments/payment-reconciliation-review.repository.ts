import type { RowDataPacket } from "mysql2/promise";
import { getPaymentConnection, hasPaymentBillingPermission } from "./payment.repository";

interface PaymentReviewRow extends RowDataPacket {
  id: string;
  business_id: string;
  checkout_order_id: string;
  gateway: string;
  merchant_reference: string | null;
  amount_lkr: string;
  payment_status: string;
  initiation_status: string;
  checkout_status: string;
  checkout_amount_lkr: string;
  verified_at: Date | null;
}

interface EvidenceReviewRow extends RowDataPacket {
  id: string;
  gateway: string;
  source: string;
  source_reference: string;
  outcome: string;
  assessment: string;
  authentication_status: string;
  observed_at: Date;
  received_at: Date;
  claimed_business_id: string;
  claimed_checkout_order_id: string;
  merchant_reference: string;
  amount_lkr: string;
  currency: string;
  gateway_order_id: string | null;
  gateway_transaction_id: string | null;
  payload_sha256: string;
}

export interface ReconciliationEvidenceReview {
  evidenceId: string;
  gateway: string;
  source: string;
  sourceReference: string;
  reportedOutcome: string;
  assessment: string;
  recordedAuthenticationStatus: string;
  observedAt: Date;
  receivedAt: Date;
  claimedBusinessId: string;
  claimedCheckoutOrderId: string;
  claimedMerchantReference: string;
  reportedAmountLkr: string;
  currency: string;
  gatewayOrderId: string | null;
  gatewayTransactionId: string | null;
  payloadSha256: string;
}

export interface PaymentReconciliationReview {
  paymentId: string;
  businessId: string;
  checkoutOrderId: string;
  gateway: string;
  merchantReference: string | null;
  expectedAmountLkr: string;
  checkoutAmountLkr: string;

  paymentStatus: string;
  initiationStatus: string;
  checkoutStatus: string;
  verifiedAt: Date | null;

  evidence: ReconciliationEvidenceReview[];
  hasMoreEvidence: boolean;

  // Advisory only. Never use this result to authorize payment.
  reviewMode: "READ_ONLY";
  automaticPaymentUpdateAllowed: false;
  automaticSubscriptionActivationAllowed: false;
  automaticGatewayRetryAllowed: false;
}

/**
 * Read-only internal review.
 *
 * No payment updates.
 * No checkout updates.
 * No subscription activation.
 * No gateway calls or retries.
 *
 * Database evidence labels are observations, not independent
 * authentication or payment authorization.
 */
export async function getPaymentReconciliationReview(
  paymentId: string,
  businessId: string,
  authenticatedUserId: string
): Promise<PaymentReconciliationReview | null> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("RECONCILIATION_REVIEW_NOT_ENABLED");
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (
    typeof paymentId !== "string" ||
    typeof businessId !== "string" ||
    typeof authenticatedUserId !== "string" ||
    !uuidPattern.test(paymentId) ||
    !uuidPattern.test(businessId) ||
    !uuidPattern.test(authenticatedUserId)
  ) {
    throw new Error("INVALID_RECONCILIATION_REVIEW_CONTEXT");
  }

  const connection = await getPaymentConnection();

  try {
    // authenticatedUserId must come from a verified server session.
    // Never trust a user ID supplied directly by a public request.
    const authorized = await hasPaymentBillingPermission(
      connection,
      businessId,
      authenticatedUserId
    );

    if (!authorized) {
      return null;
    }

    const [payments] =
      await connection.execute<PaymentReviewRow[]>(
        `SELECT
           p.id,
           p.business_id,
           p.checkout_order_id,
           p.gateway,
           p.merchant_reference,
           p.amount_lkr,
           p.status AS payment_status,
           p.initiation_status,
           p.verified_at,
           c.status AS checkout_status,
           c.amount_lkr AS checkout_amount_lkr
         FROM platform_payment_transactions p
         INNER JOIN checkout_orders c
           ON c.id = p.checkout_order_id
          AND c.business_id = p.business_id
         WHERE p.id = ?
           AND p.business_id = ?
         LIMIT 1`,
        [paymentId, businessId]
      );

    if (payments.length === 0) {
      return null;
    }

    const payment = payments[0];

    // Fetch at most 101 rows, returning 100 to the caller.
    const [rows] =
      await connection.execute<EvidenceReviewRow[]>(
        `SELECT
           id,
           gateway,
           source,
           source_reference,
           outcome,
           assessment,
           authentication_status,
           observed_at,
           received_at,
           claimed_business_id,
           claimed_checkout_order_id,
           merchant_reference,
           amount_lkr,
           currency,
           gateway_order_id,
           gateway_transaction_id,
           payload_sha256
         FROM payment_reconciliation_evidence
         WHERE payment_id = ?
         ORDER BY received_at DESC, id DESC
         LIMIT 101`,
        [paymentId]
      );

    const evidence = rows.slice(0, 100).map(row => ({
      evidenceId: row.id,
      gateway: row.gateway,
      source: row.source,
      sourceReference: row.source_reference,
      reportedOutcome: row.outcome,
      assessment: row.assessment,
      recordedAuthenticationStatus: row.authentication_status,
      observedAt: row.observed_at,
      receivedAt: row.received_at,
      claimedBusinessId: row.claimed_business_id,
      claimedCheckoutOrderId: row.claimed_checkout_order_id,
      claimedMerchantReference: row.merchant_reference,
      reportedAmountLkr: String(row.amount_lkr),
      currency: row.currency,
      gatewayOrderId: row.gateway_order_id,
      gatewayTransactionId: row.gateway_transaction_id,
      payloadSha256: row.payload_sha256,
    }));

    return {
      paymentId: payment.id,
      businessId: payment.business_id,
      checkoutOrderId: payment.checkout_order_id,
      gateway: payment.gateway,
      merchantReference: payment.merchant_reference,
      expectedAmountLkr: String(payment.amount_lkr),
      checkoutAmountLkr: String(payment.checkout_amount_lkr),

      paymentStatus: payment.payment_status,
      initiationStatus: payment.initiation_status,
      checkoutStatus: payment.checkout_status,
      verifiedAt: payment.verified_at,

      evidence,
      hasMoreEvidence: rows.length > 100,

      reviewMode: "READ_ONLY",
      automaticPaymentUpdateAllowed: false,
      automaticSubscriptionActivationAllowed: false,
      automaticGatewayRetryAllowed: false,
    };

  } finally {
    connection.release();
  }
}