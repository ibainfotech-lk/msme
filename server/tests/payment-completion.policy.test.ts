import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";

import {
  assessMockPaymentCompletion,
  type MockPaymentCompletionContext,
  type MockPaymentCompletionRejection,
} from "../src/modules/payments/payment-completion.policy";

const previousEnvironment = process.env.NODE_ENV;
process.env.NODE_ENV = "development";

after(() => {
  if (previousEnvironment === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousEnvironment;
  }
});

function fixture(): MockPaymentCompletionContext {
  const businessId = randomUUID();
  const checkoutOrderId = randomUUID();
  const gatewayOrderId = "mock_order_" + randomUUID();

  return {
    order: {
      id: checkoutOrderId,
      business_id: businessId,
      status: "PROCESSING",
      amount_lkr: "499.00",
      gateway_order_id: gatewayOrderId,
    },
    payment: {
      id: randomUUID(),
      business_id: businessId,
      checkout_order_id: checkoutOrderId,
      gateway: "MOCK",
      status: "PENDING",
      initiation_status: "INITIATED",
      amount_lkr: "499.00",
      merchant_reference: "noteto_" + randomUUID(),
      gateway_order_id: gatewayOrderId,
      gateway_transaction_id: null,
      verified_at: null,
    },
    verification: {
      provider: "MOCK",
      gatewayOrderId,
      gatewayTransactionId: "mock_txn_" + randomUUID(),
      status: "SUCCEEDED",
      amountLkr: "499.00",
      currency: "LKR",
      verifiedAt: new Date(),
    },
  };
}

function expectDenied(
  context: MockPaymentCompletionContext,
  code: MockPaymentCompletionRejection
): void {
  assert.deepEqual(assessMockPaymentCompletion(context), {
    eligible: false,
    code,
  });
}

test("accepts only a matching, completed mock gateway verification", () => {
  const input = fixture();
  const decision = assessMockPaymentCompletion(input);
  assert.equal(decision.eligible, true);
  if (decision.eligible) {
    assert.equal(decision.gatewayTransactionId, input.verification.gatewayTransactionId);
    assert.strictEqual(decision.verifiedAt, input.verification.verifiedAt);
  }
});

test("never permits mock completion outside development", () => {
  const input = fixture();
  try {
    for (const environment of ["production", "test", "staging"]) {
      process.env.NODE_ENV = environment;
      expectDenied(input, "MOCK_GATEWAY_DISABLED");
    }
  } finally {
    process.env.NODE_ENV = "development";
  }
});

test("rejects mismatched tenant and checkout identity", () => {
  const wrongBusiness = fixture();
  wrongBusiness.payment.business_id = randomUUID();
  expectDenied(wrongBusiness, "PAYMENT_CONTEXT_MISMATCH");

  const wrongOrder = fixture();
  wrongOrder.payment.checkout_order_id = randomUUID();
  expectDenied(wrongOrder, "PAYMENT_CONTEXT_MISMATCH");
});

test("rejects already-verified payments", () => {
  const input = fixture();
  input.payment.gateway_transaction_id = "mock_txn_" + randomUUID();
  expectDenied(input, "PAYMENT_ALREADY_VERIFIED");

  const other = fixture();
  other.payment.verified_at = new Date();
  expectDenied(other, "PAYMENT_ALREADY_VERIFIED");
});

test("rejects order and payment state mismatches", () => {
  const wrongOrder = fixture();
  wrongOrder.order.status = "PAID";
  expectDenied(wrongOrder, "PAYMENT_STATE_CONFLICT");

  const wrongPayment = fixture();
  wrongPayment.payment.status = "SUCCEEDED";
  expectDenied(wrongPayment, "PAYMENT_STATE_CONFLICT");
});

test("never accepts unresolved payment initiation", () => {
  for (const status of ["UNKNOWN", "RESERVED", "INITIATING", "FAILED"] as const) {
    const input = fixture();
    input.payment.initiation_status = status;
    expectDenied(input, "PAYMENT_INITIATION_CONFLICT");
  }
});

test("rejects non-mock providers and mismatched gateway orders", () => {
  const bank = fixture();
  bank.verification.provider = "COMMERCIAL_BANK";
  expectDenied(bank, "PROVIDER_NOT_MOCK");

  const wrongGateway = fixture();
  wrongGateway.verification.gatewayOrderId = "mock_order_" + randomUUID();
  expectDenied(wrongGateway, "GATEWAY_ORDER_MISMATCH");

  const wrongSavedId = fixture();
  wrongSavedId.payment.gateway_order_id = "mock_order_" + randomUUID();
  expectDenied(wrongSavedId, "GATEWAY_ORDER_MISMATCH");
});

test("pending, failed, or cancelled outcomes cannot activate", () => {
  for (const status of ["PENDING", "FAILED", "CANCELLED"] as const) {
    const input = fixture();
    input.verification.status = status;
    expectDenied(input, "GATEWAY_OUTCOME_NOT_SUCCEEDED");
  }
});

test("rejects mismatched currency and monetary values", () => {
  const currency = fixture();
  currency.verification.currency = "USD" as "LKR";
  expectDenied(currency, "PAYMENT_AMOUNT_MISMATCH");

  const amount = fixture();
  amount.verification.amountLkr = "498.00";
  expectDenied(amount, "PAYMENT_AMOUNT_MISMATCH");

  const invalid = fixture();
  invalid.order.amount_lkr = "0.00";
  expectDenied(invalid, "PAYMENT_AMOUNT_MISMATCH");
});

test("requires an actual mock transaction ID and valid verification time", () => {
  const noTransaction = fixture();
  noTransaction.verification.gatewayTransactionId = null;
  expectDenied(noTransaction, "GATEWAY_TRANSACTION_INVALID");

  const counterfeitId = fixture();
  counterfeitId.verification.gatewayTransactionId = "bank_txn_123";
  expectDenied(counterfeitId, "GATEWAY_TRANSACTION_INVALID");

  const invalidDate = fixture();
  invalidDate.verification.verifiedAt = new Date(Number.NaN);
  expectDenied(invalidDate, "VERIFICATION_TIME_INVALID");
});

console.log("INFO: Pure policy tests perform no database or payment writes.");
