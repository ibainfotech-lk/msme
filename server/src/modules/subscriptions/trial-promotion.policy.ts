/**
 * F.16.5: pure, fail-closed eligibility rules.
 *
 * IMPORTANT: Inputs must come from authenticated server-side records and verified
 * identity evidence, NOT from a browser request body. These functions only make
 * decisions; they NEVER create grants, subscriptions, payments or checkout orders.
 * The transactional activation/redemption implementations belong to later steps.
 */

export const INTRODUCTORY_TRIAL_MONTHS = 3 as const;
export const SUPPORTED_PROMOTION_MONTHS = [1, 3, 6] as const;

export type PendingBusinessStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "CLOSED";

export type OfferRejectionCode =
  | "INVALID_POLICY_INPUT"
  | "BUSINESS_IDENTITY_NOT_VERIFIED"
  | "BUSINESS_NOT_PENDING"
  | "SUBSCRIPTION_ALREADY_EXISTS"
  | "PREVIOUS_SUBSCRIPTION"
  | "TRIAL_ALREADY_GRANTED"
  | "OTHER_FREE_OFFER_ALREADY_GRANTED"
  | "PAYMENT_RECONCILIATION_REQUIRED"
  | "PROMOTION_ALREADY_REDEEMED"
  | "PROMOTION_INACTIVE"
  | "PROMOTION_NOT_STARTED"
  | "PROMOTION_EXPIRED"
  | "PROMOTION_LIMIT_REACHED"
  | "UNSUPPORTED_PROMOTION_DURATION";

export type OfferDecision =
  | { eligible: true; freeMonths: 1 | 3 | 6 }
  | { eligible: false; code: OfferRejectionCode };

export interface CommonOfferContext {
  /** Must reflect strong, server-validated business identity evidence. */
  businessIdentityVerified: boolean;
  businessStatus: PendingBusinessStatus;
  currentSubscriptionId: string | null;
  /** Count all relevant prior grants across the verified identity, not only this ID. */
  previousTrialGrantCount: number;
  previousOtherFreeGrantCount: number;
  /** Includes unsuccessful/expired subscriptions if they ever existed. */
  previousSubscriptionCount: number;
  /** ANY recorded attempt blocks free activation until reconciliation. */
  paymentAttemptCount: number;
}

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const reject = (code: OfferRejectionCode): OfferDecision => ({ eligible: false, code });

function commonRejection(context: CommonOfferContext): OfferRejectionCode | null {
  if (
    !isCount(context.previousTrialGrantCount) ||
    !isCount(context.previousOtherFreeGrantCount) ||
    !isCount(context.previousSubscriptionCount) ||
    !isCount(context.paymentAttemptCount)
  ) return "INVALID_POLICY_INPUT";
  if (!context.businessIdentityVerified) return "BUSINESS_IDENTITY_NOT_VERIFIED";
  if (context.businessStatus !== "PENDING") return "BUSINESS_NOT_PENDING";
  if (context.currentSubscriptionId !== null) return "SUBSCRIPTION_ALREADY_EXISTS";
  if (context.paymentAttemptCount !== 0) return "PAYMENT_RECONCILIATION_REQUIRED";
  if (context.previousOtherFreeGrantCount !== 0) return "OTHER_FREE_OFFER_ALREADY_GRANTED";
  if (context.previousTrialGrantCount !== 0) return "TRIAL_ALREADY_GRANTED";
  if (context.previousSubscriptionCount !== 0) return "PREVIOUS_SUBSCRIPTION";
  return null;
}

export function assessIntroductoryTrial(context: CommonOfferContext): OfferDecision {
  const code = commonRejection(context);
  return code ? reject(code) : { eligible: true, freeMonths: INTRODUCTORY_TRIAL_MONTHS };
}

export interface PromotionSnapshot {
  status: "ACTIVE" | "INACTIVE" | "EXPIRED";
  freeMonths: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  alreadyRedeemedForBusiness: boolean;
}

/** Preflight only: quota/uniqueness MUST be checked again under MySQL row locks. */
export function assessPromotion(
  context: CommonOfferContext,
  promotion: PromotionSnapshot,
  now: Date
): OfferDecision {
  const code = commonRejection(context);
  if (code) return reject(code);
  if (!isCount(promotion.redemptionCount) ||
      (promotion.maxRedemptions !== null && !isCount(promotion.maxRedemptions)) ||
      !Number.isFinite(now.getTime()) ||
      (promotion.startsAt !== null && !Number.isFinite(promotion.startsAt.getTime())) ||
      (promotion.expiresAt !== null && !Number.isFinite(promotion.expiresAt.getTime()))) {
    return reject("INVALID_POLICY_INPUT");
  }
  if (promotion.alreadyRedeemedForBusiness) return reject("PROMOTION_ALREADY_REDEEMED");
  if (promotion.status !== "ACTIVE") return reject("PROMOTION_INACTIVE");
  if (promotion.freeMonths !== 1 && promotion.freeMonths !== 3 && promotion.freeMonths !== 6) {
    return reject("UNSUPPORTED_PROMOTION_DURATION");
  }
  if (promotion.startsAt && now < promotion.startsAt) return reject("PROMOTION_NOT_STARTED");
  // Validity interval is [startsAt, expiresAt), i.e. expiresAt is exclusive.
  if (promotion.expiresAt && now >= promotion.expiresAt) return reject("PROMOTION_EXPIRED");
  if (promotion.maxRedemptions !== null &&
      promotion.redemptionCount >= promotion.maxRedemptions) {
    return reject("PROMOTION_LIMIT_REACHED");
  }
  return { eligible: true, freeMonths: promotion.freeMonths };
}

/** Calendar-month arithmetic, UTC, clamped at month-end; NOT 30 days/month. */
export function addUtcCalendarMonthsClamped(start: Date, months: 1 | 3 | 6): Date {
  if (!Number.isFinite(start.getTime())) throw new TypeError("Invalid start date");
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  const day = Math.min(start.getUTCDate(), lastDay);
  return new Date(Date.UTC(
    year, month + months, day,
    start.getUTCHours(), start.getUTCMinutes(),
    start.getUTCSeconds(), start.getUTCMilliseconds()
  ));
}
