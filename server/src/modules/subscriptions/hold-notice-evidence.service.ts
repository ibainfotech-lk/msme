import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";

/**
 * F.16.5.4l — inspect *stored* delivery evidence, never make an eligibility
 * decision or transition an account. Provider callback authentication and
 * trusted message/terms linking are NOT implemented: even a VERIFIED row in
 * this table does not independently authorize a real customer hold.
 *
 * No HTTP entry point. CI-only until authentic provider callbacks and an
 * independent platform approval service exist.
 */
export class HoldNoticeEvidenceError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "HoldNoticeEvidenceError";
  }
}
export interface HoldNoticeQuery {
  businessId: string;
  subscriptionId: string;
  reviewerUserId: string;
  billingStatementSha256: string;
  termsVersion: string;
  asOf: Date;
}
export type HoldNoticeCode =
  | "NO_MATCHING_NOTICE"
  | "UNVERIFIED_PROVIDER_RECEIPT"
  | "INVALID_STORED_PROVENANCE"
  | "GRACE_PERIOD_IN_PROGRESS"
  | "GRACE_DEADLINE_RECORDED";
export interface HoldNoticeInspection {
  code: HoldNoticeCode;
  receiptId: string | null;
  deliveredAt: string | null;
  graceEndsAt: string | null;
  /** The record alone never authorizes account restriction. */
  transitionAuthorized: false;
  subscriptionChanged: false;
  paymentInitiated: false;
}
interface SubscriptionRow extends RowDataPacket { id: string; status: string }
interface PermissionRow extends RowDataPacket { allowed: number }
interface ReceiptRow extends RowDataPacket {
  id: string;
  provider: string;
  provider_delivery_reference: string;
  provider_event_sha256: string;
  delivered_at: Date;
  verified_at: Date | null;
  grace_ends_at: Date;
  provenance_status: "UNVERIFIED" | "VERIFIED";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/i;
type ConnectionFactory = () => Promise<PoolConnection>;

export async function inspectStoredHoldNotice(
  input: HoldNoticeQuery,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<HoldNoticeInspection> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.CI !== "true" ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.RUNNER_OS !== "Linux" ||
      process.env.GITHUB_REPOSITORY !== "ibainfotech-lk/msme" ||
      process.env.NOTETO_CI_DISPOSABLE_DB !== "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" ||
      process.env.DB_HOST !== "127.0.0.1" ||
      process.env.DB_PORT !== "3307" ||
      process.env.DB_NAME !== "noteto_dev" ||
      process.env.DB_USER !== "noteto_services" ||
      process.env.DB_PASSWORD !== "ci_dummy_unused_password" ||
      process.env.NOTETO_HOLD_NOTICE_EVIDENCE_ENABLED !== "true") {
    throw new HoldNoticeEvidenceError("HOLD_NOTICE_INSPECTION_DISABLED");
  }
  if (!uuid.test(input.businessId) || !uuid.test(input.subscriptionId) ||
      !uuid.test(input.reviewerUserId) ||
      !sha.test(input.billingStatementSha256) ||
      typeof input.termsVersion !== "string" ||
      input.termsVersion.length < 2 || input.termsVersion.length > 40 ||
      !(input.asOf instanceof Date) || !Number.isFinite(input.asOf.getTime()) ||
      input.asOf.getTime() > Date.now()) {
    throw new HoldNoticeEvidenceError("INVALID_NOTICE_INSPECTION", 400);
  }

  const connection = await getConnection();
  let started = false;
  const result = (
    code: HoldNoticeCode,
    receipt: ReceiptRow | null = null
  ): HoldNoticeInspection => ({
    code,
    receiptId: receipt?.id ?? null,
    deliveredAt: receipt?.delivered_at instanceof Date
      ? receipt.delivered_at.toISOString() : null,
    graceEndsAt: receipt?.grace_ends_at instanceof Date
      ? receipt.grace_ends_at.toISOString() : null,
    transitionAuthorized: false,
    subscriptionChanged: false,
    paymentInitiated: false,
  });

  try {
    await connection.beginTransaction();
    started = true;
    const [marker] = await connection.execute<(RowDataPacket & { token: string })[]>(
      "SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"
    );
    if (marker[0]?.token !== "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE") {
      throw new HoldNoticeEvidenceError("DISPOSABLE_DB_MARKER_REQUIRED");
    }
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || business.status !== "ACTIVE") {
      throw new HoldNoticeEvidenceError("BUSINESS_NOT_ELIGIBLE");
    }
    const [subs] = await connection.execute<SubscriptionRow[]>(
      [
        "SELECT bs.id, bs.status FROM businesses b JOIN business_subscriptions bs",
        "ON bs.id=b.current_subscription_id AND bs.business_id=b.id",
        "WHERE b.id=? FOR UPDATE",
      ].join(" "),
      [input.businessId]
    );
    const subscription = subs[0];
    if (!subscription || subscription.id !== input.subscriptionId ||
        subscription.status !== "ACTIVE") {
      throw new HoldNoticeEvidenceError("CURRENT_ACTIVE_SUBSCRIPTION_REQUIRED");
    }
    const [permissions] = await connection.execute<PermissionRow[]>(
      [
        "SELECT 1 AS allowed FROM business_memberships bm",
        "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
        "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
        "JOIN role_permissions rp ON rp.role_id=r.id",
        "JOIN permissions p ON p.id=rp.permission_id",
        "WHERE bm.business_id=? AND bm.user_id=?",
        "AND bm.status='ACTIVE' AND p.`key`='billing.manage' LIMIT 1",
      ].join(" "),
      [input.businessId, input.reviewerUserId]
    );
    if (permissions.length !== 1) {
      throw new HoldNoticeEvidenceError("REVIEWER_PERMISSION_REQUIRED");
    }
    const [rows] = await connection.execute<ReceiptRow[]>(
      [
        "SELECT id, provider, provider_delivery_reference, provider_event_sha256,",
        "delivered_at, verified_at, grace_ends_at, provenance_status",
        "FROM subscription_hold_notice_receipts",
        "WHERE business_id=? AND subscription_id=?",
        "AND billing_statement_sha256=? AND terms_version=?",
        "AND delivered_at <= ?",
        "ORDER BY delivered_at DESC, id DESC LIMIT 1 FOR UPDATE",
      ].join(" "),
      [input.businessId, input.subscriptionId,
       input.billingStatementSha256, input.termsVersion, input.asOf]
    );
    const receipt = rows[0] ?? null;
    let inspection: HoldNoticeInspection;
    if (!receipt) {
      inspection = result("NO_MATCHING_NOTICE");
    } else if (receipt.provenance_status !== "VERIFIED") {
      inspection = result("UNVERIFIED_PROVIDER_RECEIPT", receipt);
    } else if (!receipt.provider || !receipt.provider_delivery_reference ||
        !sha.test(receipt.provider_event_sha256) ||
        !(receipt.delivered_at instanceof Date) ||
        !(receipt.verified_at instanceof Date) ||
        !(receipt.grace_ends_at instanceof Date) ||
        !Number.isFinite(receipt.verified_at.getTime()) ||
        receipt.verified_at.getTime() > input.asOf.getTime() ||
        receipt.verified_at.getTime() < receipt.delivered_at.getTime() ||
        receipt.grace_ends_at.getTime() <= receipt.delivered_at.getTime()) {
      inspection = result("INVALID_STORED_PROVENANCE", receipt);
    } else if (receipt.grace_ends_at.getTime() > input.asOf.getTime()) {
      inspection = result("GRACE_PERIOD_IN_PROGRESS", receipt);
    } else {
      inspection = result("GRACE_DEADLINE_RECORDED", receipt);
    }
    await connection.commit();
    started = false;
    return inspection;
  } catch (e) {
    if (started) await connection.rollback();
    throw e;
  } finally { connection.release(); }
}
