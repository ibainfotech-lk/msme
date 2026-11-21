import type { PaymentCheckoutOrderRow, PlatformPaymentRow } from "./payment.repository";
import type { VerifyPaymentResult } from "./gateways/payment-gateway.types";

/**
 * Guard for a future mock-only settlement service.
 *
 * IMPORTANT: verification MUST come from a trusted server-side call to
 * MockPaymentGateway.verifyPayment(), never from an HTTP request, a browser
 * callback, or UNVERIFIED reconciliation evidence.
 *
 * This pure policy authorizes NO database writes. A separate transactional
 * service must enforce locks, uniqueness, idempotency, and activation rules.
 */
export interface MockPaymentCompletionContext {
  order: Pick<
    PaymentCheckoutOrderRow,
    "id" | "business_id" | "status" | "amount_lkr" | "gateway_order_id"
  >;
  payment: Pick<
    PlatformPaymentRow,
    | "id"
    | "business_id"
    | "checkout_order_id"
    | "gateway"
    | "status"
    | "initiation_status"
    | "amount_lkr"
    | "merchant_reference"
    | "gateway_order_id"
    | "gateway_transaction_id"
    | "verified_at"
  >;
  verification: VerifyPaymentResult;
}

export type MockPaymentCompletionRejection =
  | "MOCK_GATEWAY_DISABLED"
  | "PAYMENT_CONTEXT_MISMATCH"
  | "PAYMENT_ALREADY_VERIFIED"
  | "PAYMENT_STATE_CONFLICT"
  | "PAYMENT_INITIATION_CONFLICT"
  | "PROVIDER_NOT_MOCK"
  | "GATEWAY_ORDER_MISMATCH"
  | "GATEWAY_OUTCOME_NOT_SUCCEEDED"
  | "PAYMENT_AMOUNT_MISMATCH"
  | "GATEWAY_TRANSACTION_INVALID"
  | "VERIFICATION_TIME_INVALID";

export type MockPaymentCompletionAssessment =
  | { eligible: false; code: MockPaymentCompletionRejection }
  | { eligible: true; gatewayTransactionId: string; verifiedAt: Date };

const amountPattern = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
const mockTransactionPattern = /^mock_txn_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validAmount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    amountPattern.test(value) &&
    value !== "0.00"
  );
}

function reject(code: MockPaymentCompletionRejection): MockPaymentCompletionAssessment {
  return { eligible: false, code };
}

/**
 * Successful gateway initiation is NOT evidence of settlement.
 * Never call this policy for bank payments or from a public route.
 */
export function assessMockPaymentCompletion(
  context: MockPaymentCompletionContext
): MockPaymentCompletionAssessment {
  const { order, payment, verification } = context;

  if (process.env.NODE_ENV !== "development") {
    return reject("MOCK_GATEWAY_DISABLED");
  }

  if (
    !order.id ||
    !order.business_id ||
    !payment.id ||
    order.business_id !== payment.business_id ||
    order.id !== payment.checkout_order_id
  ) {
    return reject("PAYMENT_CONTEXT_MISMATCH");
  }

  if (payment.gateway_transaction_id !== null || payment.verified_at !== null) {
    return reject("PAYMENT_ALREADY_VERIFIED");
  }

  if (order.status !== "PROCESSING" || payment.status !== "PENDING") {
    return reject("PAYMENT_STATE_CONFLICT");
  }

  if (payment.initiation_status !== "INITIATED") {
    // UNKNOWN initiation is never cleared by this guard.
    return reject("PAYMENT_INITIATION_CONFLICT");
  }

  if (payment.gateway !== "MOCK" || verification.provider !== "MOCK") {
    return reject("PROVIDER_NOT_MOCK");
  }

  if (
    typeof payment.merchant_reference !== "string" ||
    payment.merchant_reference.length === 0 ||
    typeof order.gateway_order_id !== "string" ||
    !order.gateway_order_id.startsWith("mock_order_") ||
    payment.gateway_order_id !== order.gateway_order_id ||
    verification.gatewayOrderId !== order.gateway_order_id
  ) {
    return reject("GATEWAY_ORDER_MISMATCH");
  }

  if (verification.status !== "SUCCEEDED") {
    return reject("GATEWAY_OUTCOME_NOT_SUCCEEDED");
  }

  if (
    verification.currency !== "LKR" ||
    !validAmount(order.amount_lkr) ||
    !validAmount(payment.amount_lkr) ||
    !validAmount(verification.amountLkr) ||
    order.amount_lkr !== payment.amount_lkr ||
    order.amount_lkr !== verification.amountLkr
  ) {
    return reject("PAYMENT_AMOUNT_MISMATCH");
  }

  if (
    typeof verification.gatewayTransactionId !== "string" ||
    !mockTransactionPattern.test(verification.gatewayTransactionId)
  ) {
    return reject("GATEWAY_TRANSACTION_INVALID");
  }

  if (
    !(verification.verifiedAt instanceof Date) ||
    !Number.isFinite(verification.verifiedAt.getTime())
  ) {
    return reject("VERIFICATION_TIME_INVALID");
  }

  // A payment initiated before checkout expiry may settle later.
  // Expiry is checked on initiation, not retroactively on settlement.
  return {
    eligible: true,
    gatewayTransactionId: verification.gatewayTransactionId,
    verifiedAt: verification.verifiedAt,
  };
}
