import type { MonthlyArrearsQuote } from "./subscription-arrears.policy";

/**
 * F.16.5.4j: READ-ONLY decision support for a future reviewed hold/recovery
 * workflow. This module NEVER changes a subscription, posts a due, charges a
 * bank account, or releases access. No caller in production.
 *
 * All evidence must be loaded by trusted, business-scoped repositories.
 * Never populate these fields from HTTP input or client-side state.
 */
export type ReviewedTransition = "PLACE_HOLD" | "RESTORE_ACCESS";
export type DecisionCode =
  | "REVIEW_READY"
  | "UNAUTHORIZED_BUSINESS_STATE"
  | "UNSUPPORTED_SUBSCRIPTION_STATE"
  | "VERIFIED_BILLING_EVIDENCE_REQUIRED"
  | "BILLING_QUOTE_STALE_OR_INVALID"
  | "PAYMENT_OR_DISPUTE_RECONCILIATION_REQUIRED"
  | "TRIAL_OR_PROMOTION_ENTITLEMENT_UNRESOLVED"
  | "NOTICE_OR_GRACE_EVIDENCE_REQUIRED"
  | "GRACE_PERIOD_IN_PROGRESS"
  | "ALREADY_PAID"
  | "OUTSTANDING_BALANCE_NOT_SETTLED"
  | "HOLD_TIMESTAMP_REQUIRED"
  | "MANUAL_REVIEW_REQUIRED";

export interface HoldLifecycleEvidence {
  transition: ReviewedTransition;
  businessStatus: string;
  currentSubscriptionStatus: string;
  asOf: Date;
  /** Quote must be obtained from a verified, complete monthly SQL ledger. */
  verifiedQuote: MonthlyArrearsQuote | null;
  monthlyHistoryReviewed: boolean;
  verifiedPaymentHistoryReady: boolean;
  hasUnresolvedPaymentAttempts: boolean;
  hasDisputesOrChargebacks: boolean;
  trialOrPromotionEntitlementUnresolved: boolean;
  /** Agreed grace deadline for a hold. No default grace period. */
  graceEndsAt: Date | null;
  noticeDeliveredAt: Date | null;
  noticeReference: string | null;
  /** Original recorded start of current hold; required to restore. */
  heldAt: Date | null;
  /** Approval belongs to a trusted internal actor, not the customer. */
  reviewApproved: boolean;
  reviewedBy: string | null;
}

export interface HoldLifecycleDecision {
  transition: ReviewedTransition;
  readyForManualExecution: boolean;
  code: DecisionCode;
  outstandingLkr: string | null;
  /** This policy does not mutate state or initiate collection. */
  subscriptionChanged: false;
  paymentInitiated: false;
}

const moneyPattern = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
function moneyInCents(value: string): number | null {
  if (typeof value !== "string" || !moneyPattern.test(value)) return null;
  const [major, minor] = value.split(".");
  const n = Number(major) * 100 + Number(minor);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function validPastDate(date: Date | null, asOf: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime()) &&
    date.getTime() <= asOf.getTime();
}
function localMonth(asOf: Date): string {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    year: "numeric", month: "2-digit",
  }).formatToParts(asOf);
  const year = fields.find(x => x.type === "year")?.value;
  const month = fields.find(x => x.type === "month")?.value;
  return year + "-" + month + "-01";
}
function quoteTotal(quote: MonthlyArrearsQuote, asOf: Date): number | null {
  if (!quote || quote.currency !== "LKR" ||
      quote.paymentActionAllowed !== false || quote.penaltyLkr !== "0.00" ||
      quote.asOf !== asOf.toISOString() ||
      quote.completeThroughMonth !== localMonth(asOf) ||
      !Array.isArray(quote.lines) || quote.lines.length < 1) {
    return null;
  }
  const total = moneyInCents(quote.totalOutstandingLkr);
  if (total === null) return null;
  let lineTotal = 0;
  const seen = new Set<string>();
  for (const line of quote.lines) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(line.billingMonth) ||
        seen.has(line.billingMonth) ||
        moneyInCents(line.chargeLkr) === null ||
        moneyInCents(line.waivedLkr) === null ||
        moneyInCents(line.verifiedPaidLkr) === null) return null;
    const outstanding = moneyInCents(line.outstandingLkr);
    if (outstanding === null) return null;
    seen.add(line.billingMonth);
    lineTotal += outstanding;
    if (!Number.isSafeInteger(lineTotal)) return null;
  }
  return lineTotal === total ? total : null;
}

export function reviewHoldLifecycle(e: HoldLifecycleEvidence): HoldLifecycleDecision {
  const result = (code: DecisionCode, outstandingLkr: string | null): HoldLifecycleDecision => ({
    transition: e.transition,
    readyForManualExecution: code === "REVIEW_READY",
    code,
    outstandingLkr,
    subscriptionChanged: false,
    paymentInitiated: false,
  });

  // If any trusted source is missing or stale, the system cannot issue a
  // positive transition recommendation.
  if (!(e.asOf instanceof Date) || !Number.isFinite(e.asOf.getTime()) ||
      e.businessStatus !== "ACTIVE") return result("UNAUTHORIZED_BUSINESS_STATE", null);

  if ((e.transition === "PLACE_HOLD" && e.currentSubscriptionStatus !== "ACTIVE") ||
      (e.transition === "RESTORE_ACCESS" && e.currentSubscriptionStatus !== "PAST_DUE")) {
    return result("UNSUPPORTED_SUBSCRIPTION_STATE", null);
  }

  if (!e.monthlyHistoryReviewed || !e.verifiedPaymentHistoryReady || !e.verifiedQuote) {
    return result("VERIFIED_BILLING_EVIDENCE_REQUIRED", null);
  }

  const due = quoteTotal(e.verifiedQuote, e.asOf);
  if (due === null) return result("BILLING_QUOTE_STALE_OR_INVALID", null);
  const amount = e.verifiedQuote.totalOutstandingLkr;

  if (e.hasUnresolvedPaymentAttempts || e.hasDisputesOrChargebacks) {
    return result("PAYMENT_OR_DISPUTE_RECONCILIATION_REQUIRED", amount);
  }
  if (e.trialOrPromotionEntitlementUnresolved) {
    return result("TRIAL_OR_PROMOTION_ENTITLEMENT_UNRESOLVED", amount);
  }

  if (e.transition === "PLACE_HOLD") {
    if (due === 0) return result("ALREADY_PAID", amount);
    if (!validPastDate(e.noticeDeliveredAt, e.asOf) ||
        !e.noticeReference || e.noticeReference.trim().length < 4 ||
        !(e.graceEndsAt instanceof Date) ||
        !Number.isFinite(e.graceEndsAt.getTime()) ||
        e.graceEndsAt.getTime() <= e.noticeDeliveredAt!.getTime()) {
      return result("NOTICE_OR_GRACE_EVIDENCE_REQUIRED", amount);
    }
    if (e.graceEndsAt.getTime() > e.asOf.getTime()) {
      return result("GRACE_PERIOD_IN_PROGRESS", amount);
    }
  } else {
    if (!validPastDate(e.heldAt, e.asOf)) return result("HOLD_TIMESTAMP_REQUIRED", amount);
    if (due > 0) return result("OUTSTANDING_BALANCE_NOT_SETTLED", amount);
  }

  if (!e.reviewApproved || typeof e.reviewedBy !== "string" ||
      e.reviewedBy.trim().length < 4) {
    return result("MANUAL_REVIEW_REQUIRED", amount);
  }
  return result("REVIEW_READY", amount);
}
