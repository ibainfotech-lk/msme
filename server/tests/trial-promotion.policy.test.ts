import assert from "node:assert/strict";
import test from "node:test";
import {
  addUtcCalendarMonthsClamped,
  assessIntroductoryTrial,
  assessPromotion,
  type CommonOfferContext,
  type PromotionSnapshot,
} from "../src/modules/subscriptions/trial-promotion.policy";

const context: CommonOfferContext = {
  businessIdentityVerified: true,
  businessStatus: "PENDING",
  currentSubscriptionId: null,
  previousTrialGrantCount: 0,
  previousOtherFreeGrantCount: 0,
  previousSubscriptionCount: 0,
  paymentAttemptCount: 0,
};
const promo: PromotionSnapshot = {
  status: "ACTIVE", freeMonths: 6,
  startsAt: new Date("2026-11-01T00:00:00Z"),
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  maxRedemptions: 5, redemptionCount: 4,
  alreadyRedeemedForBusiness: false,
};
const now = new Date("2026-11-21T00:00:00Z");

test("eligible verified business receives 3 calendar months", () => {
  assert.deepEqual(assessIntroductoryTrial(context), { eligible: true, freeMonths: 3 });
});

test("never grant a trial without verified business identity", () => {
  assert.deepEqual(assessIntroductoryTrial({ ...context, businessIdentityVerified: false }),
    { eligible: false, code: "BUSINESS_IDENTITY_NOT_VERIFIED" });
});

test("previous trial or subscription prevents another trial", () => {
  assert.equal(assessIntroductoryTrial({ ...context, previousTrialGrantCount: 1 }).eligible, false);
  assert.equal(assessIntroductoryTrial({ ...context, previousSubscriptionCount: 1 }).eligible, false);
  assert.equal(assessIntroductoryTrial({ ...context, currentSubscriptionId: "id" }).eligible, false);
});

test("do not stack offers or grant while a payment attempt exists", () => {
  assert.equal(assessIntroductoryTrial({ ...context, previousOtherFreeGrantCount: 1 }).eligible, false);
  assert.deepEqual(assessIntroductoryTrial({ ...context, paymentAttemptCount: 1 }),
    { eligible: false, code: "PAYMENT_RECONCILIATION_REQUIRED" });
});

test("promotion accepts only 1/3/6 months within its validity", () => {
  assert.deepEqual(assessPromotion(context, promo, now), { eligible: true, freeMonths: 6 });
  assert.deepEqual(assessPromotion(context, { ...promo, freeMonths: 5 }, now),
    { eligible: false, code: "UNSUPPORTED_PROMOTION_DURATION" });
  assert.deepEqual(assessPromotion(context, promo, promo.expiresAt!),
    { eligible: false, code: "PROMOTION_EXPIRED" });
});

test("promotion rejects exhausted quota, replay, and invalid counters", () => {
  assert.deepEqual(assessPromotion(context, { ...promo, redemptionCount: 5 }, now),
    { eligible: false, code: "PROMOTION_LIMIT_REACHED" });
  assert.deepEqual(assessPromotion(context, { ...promo, alreadyRedeemedForBusiness: true }, now),
    { eligible: false, code: "PROMOTION_ALREADY_REDEEMED" });
  assert.deepEqual(assessPromotion(context, { ...promo, redemptionCount: -1 }, now),
    { eligible: false, code: "INVALID_POLICY_INPUT" });
});

test("three UTC calendar months clamp February and April correctly", () => {
  assert.equal(addUtcCalendarMonthsClamped(new Date("2027-01-31T12:00:00Z"), 1).toISOString(),
    "2027-02-28T12:00:00.000Z");
  assert.equal(addUtcCalendarMonthsClamped(new Date("2027-01-31T12:00:00Z"), 3).toISOString(),
    "2027-04-30T12:00:00.000Z");
});
