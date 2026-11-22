import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import {
  reviewHoldLifecycle,
  type HoldLifecycleEvidence,
} from "./subscription-hold-lifecycle.policy";

/**
 * F.16.5.4k: DISPOSABLE-CI-ONLY journal for policy-ready review candidates.
 * No HTTP route. Does not update business_subscriptions, held_at, account
 * capabilities, payment allocations, due status, or payment transactions.
 *
 * This stage does NOT independently verify caller-provided evidence against
 * trusted billing, notice, dispute or entitlement repositories. Consequently
 * journal rows do NOT authorize a real hold/restoration; a later service must
 * load/recheck all evidence under locks before any status transition.
 */
export class HoldReviewJournalError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "HoldReviewJournalError";
  }
}

export interface RecordReviewCandidateInput {
  businessId: string;
  subscriptionId: string;
  reviewerUserId: string;
  idempotencyKey: string;
  reason: string;
  evidence: HoldLifecycleEvidence;
}
export interface RecordReviewCandidateResult {
  reviewId: string;
  transition: "PLACE_HOLD" | "RESTORE_ACCESS";
  status: "POLICY_READY";
  outstandingLkr: string;
  replayed: boolean;
  subscriptionChanged: false;
  paymentInitiated: false;
}
interface SubscriptionRow extends RowDataPacket {
  id: string;
  status: string;
  held_at: Date | null;
}
interface RoleRow extends RowDataPacket { allowed: number }
interface ExistingRow extends RowDataPacket {
  id: string;
  subscription_id: string;
  reviewer_user_id: string;
  transition_type: string;
  evidence_sha256: string;
  outstanding_lkr: string;
}
type ConnectionFactory = () => Promise<PoolConnection>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9:_-]{8,191}$/;

export async function recordHoldReviewCandidate(
  input: RecordReviewCandidateInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<RecordReviewCandidateResult> {
  // Temporary, intentionally stricter than other dev flags. May ONLY run
  // against the disposable MySQL instance created in GitHub Actions.
  if (process.env.NODE_ENV !== "development" ||
      process.env.CI !== "true" ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.RUNNER_OS !== "Linux" ||
      process.env.GITHUB_REPOSITORY !== "ibainfotech-lk/msme" ||
      process.env.NOTETO_CI_DISPOSABLE_DB !== "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" ||
      process.env.NOTETO_HOLD_REVIEW_JOURNAL_ENABLED !== "true") {
    throw new HoldReviewJournalError("HOLD_REVIEW_JOURNAL_DISABLED", 403);
  }

  if (!uuid.test(input.businessId) ||
      !uuid.test(input.subscriptionId) ||
      !uuid.test(input.reviewerUserId) ||
      !keyPattern.test(input.idempotencyKey) ||
      typeof input.reason !== "string" ||
      input.reason.trim().length < 8 ||
      input.reason.trim().length > 500 ||
      input.evidence.reviewedBy !== input.reviewerUserId ||
      input.evidence.reviewApproved !== true) {
    throw new HoldReviewJournalError("INVALID_REVIEW_CANDIDATE", 400);
  }

  // Policy is *only* a preliminary decision. Evidence is not verified here.
  const preliminary = reviewHoldLifecycle(input.evidence);
  if (!preliminary.readyForManualExecution ||
      preliminary.code !== "REVIEW_READY" ||
      preliminary.outstandingLkr === null) {
    throw new HoldReviewJournalError("REVIEW_EVIDENCE_NOT_READY", 409);
  }
  const snapshot = {
    businessId: input.businessId,
    subscriptionId: input.subscriptionId,
    reviewerUserId: input.reviewerUserId,
    transition: input.evidence.transition,
    reason: input.reason.trim(),
    evidence: {
      ...input.evidence,
      asOf: input.evidence.asOf.toISOString(),
      graceEndsAt: input.evidence.graceEndsAt?.toISOString() ?? null,
      noticeDeliveredAt: input.evidence.noticeDeliveredAt?.toISOString() ?? null,
      heldAt: input.evidence.heldAt?.toISOString() ?? null,
    },
  };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

  const connection = await getConnection();
  let inTransaction = false;
  try {
    await connection.beginTransaction();
    inTransaction = true;

    // Serialize all review attempts for a business; this must not be
    // confused with any approval to change subscription status.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || business.status !== "ACTIVE" ||
        input.evidence.businessStatus !== business.status) {
      throw new HoldReviewJournalError("REVIEW_BUSINESS_NOT_ACTIVE", 403);
    }
    const [current] = await connection.execute<SubscriptionRow[]>(
      [
        "SELECT bs.id, bs.status, bs.held_at FROM businesses b",
        "INNER JOIN business_subscriptions bs ON bs.id = b.current_subscription_id",
        "AND bs.business_id = b.id",
        "WHERE b.id = ? FOR UPDATE",
      ].join(" "),
      [input.businessId]
    );
    const subscription = current[0];
    if (!subscription || subscription.id !== input.subscriptionId ||
        subscription.status !== input.evidence.currentSubscriptionStatus) {
      throw new HoldReviewJournalError("REVIEW_CURRENT_SUBSCRIPTION_MISMATCH", 409);
    }
    const recordedHeld = subscription.held_at?.getTime() ?? null;
    const claimedHeld = input.evidence.heldAt?.getTime() ?? null;
    if (recordedHeld !== claimedHeld ||
        (input.evidence.transition === "PLACE_HOLD" && recordedHeld !== null)) {
      throw new HoldReviewJournalError("REVIEW_HOLD_EVIDENCE_MISMATCH", 409);
    }

    const [actor] = await connection.execute<RoleRow[]>(
      [
        "SELECT 1 AS allowed FROM users u",
        "INNER JOIN business_memberships bm ON bm.user_id = u.id",
        "INNER JOIN roles r ON r.business_id = bm.business_id AND r.id = bm.role_id",
        "INNER JOIN role_permissions rp ON rp.role_id = r.id",
        "INNER JOIN permissions p ON p.id = rp.permission_id",
        "WHERE u.id = ? AND u.status = 'ACTIVE'",
        "AND bm.business_id = ? AND bm.status = 'ACTIVE'",
        "AND p.`key` = 'billing.manage' LIMIT 1",
      ].join(" "),
      [input.reviewerUserId, input.businessId]
    );
    if (actor.length !== 1) throw new HoldReviewJournalError("REVIEWER_NOT_AUTHORIZED", 403);

    const [existing] = await connection.execute<ExistingRow[]>(
      [
        "SELECT id, subscription_id, reviewer_user_id, transition_type,",
        "evidence_sha256, outstanding_lkr FROM subscription_hold_review_journal",
        "WHERE business_id = ? AND idempotency_key = ? FOR UPDATE",
      ].join(" "),
      [input.businessId, input.idempotencyKey]
    );
    if (existing.length !== 0) {
      const prior = existing[0];
      if (prior.subscription_id !== input.subscriptionId ||
          prior.reviewer_user_id !== input.reviewerUserId ||
          prior.transition_type !== input.evidence.transition ||
          prior.evidence_sha256 !== evidenceSha256) {
        throw new HoldReviewJournalError("REVIEW_IDEMPOTENCY_CONFLICT", 409);
      }
      await connection.commit();
      inTransaction = false;
      return {
        reviewId: prior.id, transition: input.evidence.transition,
        status: "POLICY_READY", outstandingLkr: String(prior.outstanding_lkr),
        replayed: true, subscriptionChanged: false, paymentInitiated: false,
      };
    }

    const reviewId = randomUUID();
    await connection.execute(
      [
        "INSERT INTO subscription_hold_review_journal",
        "(id, business_id, subscription_id, reviewer_user_id, idempotency_key,",
        "transition_type, decision_status, evidence_sha256, statement_as_of,",
        "outstanding_lkr, notice_reference, grace_ends_at, review_reason, created_at)",
        "VALUES (?, ?, ?, ?, ?, ?, 'POLICY_READY', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
      ].join(" "),
      [reviewId, input.businessId, input.subscriptionId, input.reviewerUserId,
       input.idempotencyKey, input.evidence.transition, evidenceSha256,
       input.evidence.asOf, preliminary.outstandingLkr,
       input.evidence.noticeReference, input.evidence.graceEndsAt, input.reason.trim()]
    );
    await connection.commit();
    inTransaction = false;
    return {
      reviewId, transition: input.evidence.transition, status: "POLICY_READY",
      outstandingLkr: preliminary.outstandingLkr, replayed: false,
      subscriptionChanged: false, paymentInitiated: false,
    };
  } catch (error) {
    if (inTransaction) await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
