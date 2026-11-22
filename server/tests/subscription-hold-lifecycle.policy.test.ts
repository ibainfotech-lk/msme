import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reviewHoldLifecycle, type HoldLifecycleEvidence,
} from "../src/modules/subscriptions/subscription-hold-lifecycle.policy";
import type { MonthlyArrearsQuote } from "../src/modules/subscriptions/subscription-arrears.policy";

const asOf = new Date("2027-02-20T00:00:00.000Z");
const quote: MonthlyArrearsQuote = {
  currency: "LKR",
  asOf: asOf.toISOString(),
  completeThroughMonth: "2027-02-01",
  lines: [
    { billingMonth: "2027-01-01", chargeLkr: "499.00",
      waivedLkr: "0.00", verifiedPaidLkr: "0.00", outstandingLkr: "499.00" },
    { billingMonth: "2027-02-01", chargeLkr: "499.00",
      waivedLkr: "0.00", verifiedPaidLkr: "0.00", outstandingLkr: "499.00" },
  ],
  totalOutstandingLkr: "998.00",
  penaltyLkr: "0.00",
  paymentActionAllowed: false,
};

function evidence(changes: Partial<HoldLifecycleEvidence> = {}): HoldLifecycleEvidence {
  return {
    transition: "PLACE_HOLD",
    businessStatus: "ACTIVE",
    currentSubscriptionStatus: "ACTIVE",
    asOf,
    verifiedQuote: quote,
    monthlyHistoryReviewed: true,
    verifiedPaymentHistoryReady: true,
    hasUnresolvedPaymentAttempts: false,
    hasDisputesOrChargebacks: false,
    trialOrPromotionEntitlementUnresolved: false,
    graceEndsAt: new Date("2027-02-15T00:00:00.000Z"),
    noticeDeliveredAt: new Date("2027-02-01T00:00:00.000Z"),
    noticeReference: "verified_notice_2027_02",
    heldAt: null,
    reviewApproved: true,
    reviewedBy: "billing-reviewer-verified",
    ...changes,
  };
}
function settled(): MonthlyArrearsQuote {
  return {
    ...quote, totalOutstandingLkr: "0.00",
    lines: quote.lines.map(line => ({
      ...line, verifiedPaidLkr: "499.00", outstandingLkr: "0.00",
    })),
  };
}
function code(changes: Partial<HoldLifecycleEvidence>, expected: string): void {
  const result = reviewHoldLifecycle(evidence(changes));
  assert.equal(result.code, expected);
  assert.equal(result.readyForManualExecution, expected === "REVIEW_READY");
  assert.equal(result.subscriptionChanged, false);
  assert.equal(result.paymentInitiated, false);
}

test("Jan + Feb fully unpaid may be reviewed for hold only after grace, notice, verified ledger and human approval", () => {
  const result = reviewHoldLifecycle(evidence());
  assert.equal(result.code, "REVIEW_READY");
  assert.equal(result.outstandingLkr, "998.00");
  assert.equal(result.readyForManualExecution, true);
  assert.equal(result.paymentInitiated, false);
  assert.equal(result.subscriptionChanged, false);
});

test("no recorded grace deadline or notice cannot trigger a hold", () => {
  code({ graceEndsAt: null }, "NOTICE_OR_GRACE_EVIDENCE_REQUIRED");
  code({ noticeDeliveredAt: null }, "NOTICE_OR_GRACE_EVIDENCE_REQUIRED");
  code({ noticeReference: null }, "NOTICE_OR_GRACE_EVIDENCE_REQUIRED");
  code({ noticeDeliveredAt: new Date("2027-02-17T00:00:00Z") }, "NOTICE_OR_GRACE_EVIDENCE_REQUIRED");
});

test("grace period still running prevents suspension", () => {
  code({ graceEndsAt: new Date("2027-03-01T00:00:00.000Z") }, "GRACE_PERIOD_IN_PROGRESS");
});

test("an otherwise valid hold still requires a recorded internal reviewer", () => {
  code({ reviewApproved: false }, "MANUAL_REVIEW_REQUIRED");
  code({ reviewedBy: null }, "MANUAL_REVIEW_REQUIRED");
});

test("incomplete or stale billing evidence never authorizes a hold", () => {
  code({ verifiedQuote: null }, "VERIFIED_BILLING_EVIDENCE_REQUIRED");
  code({ monthlyHistoryReviewed: false }, "VERIFIED_BILLING_EVIDENCE_REQUIRED");
  code({ verifiedPaymentHistoryReady: false }, "VERIFIED_BILLING_EVIDENCE_REQUIRED");
  code({ verifiedQuote: { ...quote, asOf: new Date("2027-02-01Z").toISOString() } }, "BILLING_QUOTE_STALE_OR_INVALID");
  code({ verifiedQuote: { ...quote, completeThroughMonth: "2027-01-01" } }, "BILLING_QUOTE_STALE_OR_INVALID");
});

test("never infer hold from fabricated or mismatched totals", () => {
  code({ verifiedQuote: { ...quote, totalOutstandingLkr: "499.00" } }, "BILLING_QUOTE_STALE_OR_INVALID");
  code({ verifiedQuote: { ...quote, lines: [...quote.lines, quote.lines[0]] } }, "BILLING_QUOTE_STALE_OR_INVALID");
  code({ verifiedQuote: { ...quote, paymentActionAllowed: true as false } }, "BILLING_QUOTE_STALE_OR_INVALID");
});

test("trial/promotion uncertainty and payment/dispute issues halt the decision", () => {
  code({ trialOrPromotionEntitlementUnresolved: true }, "TRIAL_OR_PROMOTION_ENTITLEMENT_UNRESOLVED");
  code({ hasUnresolvedPaymentAttempts: true }, "PAYMENT_OR_DISPUTE_RECONCILIATION_REQUIRED");
  code({ hasDisputesOrChargebacks: true }, "PAYMENT_OR_DISPUTE_RECONCILIATION_REQUIRED");
});

test("a fully settled monthly ledger never triggers a new hold", () => {
  code({ verifiedQuote: settled() }, "ALREADY_PAID");
});

test("restoration requires an existing reviewed hold and fully settled ledger", () => {
  const base: Partial<HoldLifecycleEvidence> = {
    transition: "RESTORE_ACCESS",
    currentSubscriptionStatus: "PAST_DUE",
    heldAt: new Date("2027-02-16T00:00:00Z"),
  };
  code({ ...base, verifiedQuote: quote }, "OUTSTANDING_BALANCE_NOT_SETTLED");
  code({ ...base, verifiedQuote: settled() }, "REVIEW_READY");
  code({ ...base, verifiedQuote: settled(), heldAt: null }, "HOLD_TIMESTAMP_REQUIRED");
});

test("restoration rejects unverified payments and unauthorized approvals", () => {
  const base: Partial<HoldLifecycleEvidence> = {
    transition: "RESTORE_ACCESS",
    currentSubscriptionStatus: "PAST_DUE",
    heldAt: new Date("2027-02-16T00:00:00Z"),
    verifiedQuote: settled(),
  };
  code({ ...base, hasUnresolvedPaymentAttempts: true }, "PAYMENT_OR_DISPUTE_RECONCILIATION_REQUIRED");
  code({ ...base, hasDisputesOrChargebacks: true }, "PAYMENT_OR_DISPUTE_RECONCILIATION_REQUIRED");
  code({ ...base, reviewApproved: false }, "MANUAL_REVIEW_REQUIRED");
});

test("restoration and hold reject wrong business or subscription states", () => {
  code({ businessStatus: "SUSPENDED" }, "UNAUTHORIZED_BUSINESS_STATE");
  code({ currentSubscriptionStatus: "TRIALING" }, "UNSUPPORTED_SUBSCRIPTION_STATE");
  code({ transition: "RESTORE_ACCESS", currentSubscriptionStatus: "ACTIVE" }, "UNSUPPORTED_SUBSCRIPTION_STATE");
});

test("policy evaluation never modifies subscription state or charges the customer", () => {
  const decisions = [
    reviewHoldLifecycle(evidence()),
    reviewHoldLifecycle(evidence({
      transition: "RESTORE_ACCESS", currentSubscriptionStatus: "PAST_DUE",
      heldAt: new Date("2027-02-16T00:00:00Z"),
      verifiedQuote: settled(),
    })),
  ];
  for (const decision of decisions) {
    assert.equal(decision.subscriptionChanged, false);
    assert.equal(decision.paymentInitiated, false);
  }
});
