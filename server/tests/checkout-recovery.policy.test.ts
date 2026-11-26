import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCheckoutRecovery,
  type RecoverySnapshot,
} from "../src/modules/checkout/checkout-recovery.policy";

const now = new Date("2026-11-21T10:00:00Z");
const base: RecoverySnapshot = {
  checkoutStatus: "PENDING",
  expiresAt: new Date("2026-11-21T10:30:00Z"),
  attempts: [],
};

test("unexpired pending checkout without payment can resume", () => {
  assert.deepEqual(assessCheckoutRecovery(base, now), {
    action: "RESUME_UNPAID_CHECKOUT",
    mayReserveFirstPaymentAttempt: true,
  });
});

test("expired order with no payment may only be replaced after new checks", () => {
  assert.deepEqual(assessCheckoutRecovery({ ...base, expiresAt: now }, now), {
    action: "EXPIRED_WITHOUT_PAYMENT",
    mayReserveFirstPaymentAttempt: false,
  });
});

test("reserved, not initiated payment can be resumed without a new attempt", () => {
  assert.deepEqual(assessCheckoutRecovery({ ...base, attempts: [
    { status: "PENDING", initiationStatus: "RESERVED" },
  ] }, now), {
    action: "RESUME_RESERVED_ATTEMPT", mayReserveFirstPaymentAttempt: false,
  });
});

test("unknown, initiated and failed attempts require reconciliation", () => {
  for (const initiationStatus of ["UNKNOWN", "INITIATING", "INITIATED", "FAILED"] as const) {
    assert.equal(assessCheckoutRecovery({ ...base, attempts: [
      { status: "PENDING", initiationStatus },
    ] }, now).action, "RECONCILIATION_REQUIRED");
  }
});

test("processing and multiple attempts always require reconciliation", () => {
  assert.equal(assessCheckoutRecovery({ ...base, checkoutStatus: "PROCESSING" }, now).action,
    "RECONCILIATION_REQUIRED");
  assert.equal(assessCheckoutRecovery({ ...base, attempts: [
    { status: "FAILED", initiationStatus: "FAILED" },
    { status: "PENDING", initiationStatus: "UNKNOWN" },
  ] }, now).action, "RECONCILIATION_REQUIRED");
});

test("paid order requires settlement evidence, not a new payment", () => {
  assert.deepEqual(assessCheckoutRecovery({ ...base, checkoutStatus: "PAID" }, now), {
    action: "VERIFY_SETTLEMENT", mayReserveFirstPaymentAttempt: false,
  });
});

test("invalid or missing expiry fails closed", () => {
  assert.equal(assessCheckoutRecovery({ ...base, expiresAt: null }, now).action,
    "RECONCILIATION_REQUIRED");
});
