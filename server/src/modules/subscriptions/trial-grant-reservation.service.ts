import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { hasPaymentBillingPermission } from "../payments/payment.repository";
import { assessIntroductoryTrial } from "./trial-promotion.policy";

/**
 * F.16.5.2 INTERNAL DEVELOPMENT-ONLY trial reservation.
 * No route invokes this service. Reservation DOES NOT activate a subscription,
 * mark an order PAID, insert a payment, or grant dashboard access.
 * Only a trusted verification process may insert verified_business_identities.
 */
export class TrialReservationError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "TrialReservationError";
  }
}

export interface ReserveIntroductoryTrialInput {
  businessId: string;
  checkoutOrderId: string;
  userId: string;
}

export interface ReservedIntroductoryTrial {
  grantId: string;
  businessId: string;
  checkoutOrderId: string;
  status: "RESERVED";
  replayed: boolean;
}

type ConnectionFactory = () => Promise<PoolConnection>;
interface BusinessPointer extends RowDataPacket { current_subscription_id: string | null }
interface IdentityRow extends RowDataPacket {
  identity_fingerprint: string;
  verified_at: Date;
  revoked_at: Date | null;
}
interface OrderRow extends RowDataPacket {
  id: string;
  status: string;
  gateway_order_id: string | null;
  expires_at: Date | null;
  checkout_amount_lkr: string;
  price_lkr: string;
  billing_interval: string;
  trial_days: number;
  is_active: number;
  invoice_limit: number;
}
interface OpenOrderRow extends RowDataPacket { id: string }
interface CountRow extends RowDataPacket { n: number }
interface GrantRow extends RowDataPacket {
  id: string;
  identity_fingerprint: string;
  checkout_order_id: string;
  status: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;

async function count(connection: PoolConnection, sql: string, params: string[]): Promise<number> {
  const [rows] = await connection.execute<CountRow[]>(sql, params);
  const n = Number(rows[0]?.n);
  if (!Number.isSafeInteger(n) || n < 0) throw new TrialReservationError("INVALID_HISTORY_COUNT");
  return n;
}

function conflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ER_DUP_ENTRY" || error.code === "ER_LOCK_DEADLOCK" ||
     error.code === "ER_LOCK_WAIT_TIMEOUT");
}

/**
 * Atomically reserves the one-time trial opportunity for a verified identity
 * and cancels its *unpaid* original checkout. Any existing payment attempt,
 * including failed/unknown attempts, blocks reservation.
 *
 * This is NOT trial activation. F.16.5.3 must separately implement activation,
 * subscription linkage, entitlements, and an authenticated business gate.
 */
export async function reserveIntroductoryTrial(
  input: ReserveIntroductoryTrialInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<ReservedIntroductoryTrial> {
  if (process.env.NODE_ENV !== "development") {
    throw new TrialReservationError("TRIAL_RESERVATION_DISABLED", 403);
  }
  if (process.env.NOTETO_TRIAL_RESERVATIONS_ENABLED !== "true") {
    throw new TrialReservationError("TRIAL_RESERVATION_DISABLED", 403);
  }
  if (process.env.NOTETO_TRIAL_IDENTITY_HISTORY_READY !== "true") {
    throw new TrialReservationError("IDENTITY_HISTORY_NOT_READY", 503);
  }
  if (!uuid.test(input.businessId) || !uuid.test(input.checkoutOrderId) || !uuid.test(input.userId)) {
    throw new TrialReservationError("INVALID_TRIAL_REFERENCE", 400);
  }

  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;

    // Preserve the payment-settlement lock order: business -> checkout -> payment.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || business.status !== "PENDING") {
      throw new TrialReservationError("BUSINESS_NOT_PENDING");
    }
    if (!(await hasPaymentBillingPermission(connection, input.businessId, input.userId))) {
      throw new TrialReservationError("BILLING_PERMISSION_DENIED", 403);
    }

    const [pointers] = await connection.execute<BusinessPointer[]>(
      "SELECT current_subscription_id FROM businesses WHERE id = ? LIMIT 1",
      [input.businessId]
    );
    if (pointers.length !== 1 || pointers[0].current_subscription_id !== null) {
      throw new TrialReservationError("SUBSCRIPTION_ALREADY_EXISTS");
    }

    // Identity must be inserted by a future trusted verification workflow,
    // never sourced from an HTTP body. A phone/name alone cannot qualify.
    const [identities] = await connection.execute<IdentityRow[]>(
      ["SELECT identity_fingerprint, verified_at, revoked_at",
       "FROM verified_business_identities WHERE business_id = ? FOR UPDATE"].join(" "),
      [input.businessId]
    );
    const identity = identities[0];
    if (identities.length !== 1 || !identity || !sha256.test(identity.identity_fingerprint) ||
        identity.revoked_at !== null || !(identity.verified_at instanceof Date) ||
        !Number.isFinite(identity.verified_at.getTime()) || identity.verified_at.getTime() > Date.now()) {
      throw new TrialReservationError("BUSINESS_IDENTITY_NOT_VERIFIED");
    }

    const [orders] = await connection.execute<OrderRow[]>(
      ["SELECT co.id, co.status, co.gateway_order_id, co.expires_at,",
       "co.amount_lkr AS checkout_amount_lkr,",
       "sp.price_lkr, sp.billing_interval, sp.trial_days, sp.is_active, sp.invoice_limit",
       "FROM checkout_orders co JOIN subscription_plans sp ON sp.id = co.plan_id",
       "WHERE co.id = ? AND co.business_id = ? FOR UPDATE"].join(" "),
      [input.checkoutOrderId, input.businessId]
    );
    const order = orders[0];
    if (!order) throw new TrialReservationError("CHECKOUT_NOT_FOUND", 404);

    // An existing reservation may only replay its own cancelled order.
    const [existing] = await connection.execute<GrantRow[]>(
      ["SELECT id, identity_fingerprint, checkout_order_id, status",
       "FROM introductory_trial_grants WHERE business_id = ? FOR UPDATE"].join(" "),
      [input.businessId]
    );

    // Any attempt under the same verified identity blocks a free grant,
    // even if its initiation was FAILED or the checkout has expired.
    const payments = await count(connection,
      ["SELECT COUNT(*) AS n FROM platform_payment_transactions ppt",
       "JOIN verified_business_identities vbi ON vbi.business_id = ppt.business_id",
       "WHERE vbi.identity_fingerprint = ?"].join(" "),
      [identity.identity_fingerprint]);
    if (payments !== 0) throw new TrialReservationError("PAYMENT_RECONCILIATION_REQUIRED");

    if (existing.length !== 0) {
      const [otherOpen] = await connection.execute<OpenOrderRow[]>(
        "SELECT id FROM checkout_orders WHERE business_id = ? AND status IN ('PENDING','PROCESSING','PAID') FOR UPDATE",
        [input.businessId]
      );
      if (otherOpen.length !== 0) throw new TrialReservationError("OTHER_CHECKOUT_REQUIRES_REVIEW");
      const grant = existing[0];
      if (existing.length !== 1 || grant.identity_fingerprint !== identity.identity_fingerprint ||
          grant.checkout_order_id !== input.checkoutOrderId || grant.status !== "RESERVED" ||
          order.status !== "CANCELLED") {
        throw new TrialReservationError("TRIAL_ALREADY_GRANTED");
      }
      const [offerClaims] = await connection.execute<RowDataPacket[]>(
        "SELECT business_id, offer_kind, reservation_id FROM identity_offer_claims WHERE identity_fingerprint = ? LIMIT 1",
        [identity.identity_fingerprint]
      );
      if (offerClaims.length !== 1 || offerClaims[0].business_id !== input.businessId ||
          offerClaims[0].offer_kind !== "TRIAL" || offerClaims[0].reservation_id !== grant.id) {
        throw new TrialReservationError("OFFER_CLAIM_INCONSISTENT");
      }
      await connection.commit();
      started = false;
      return { grantId: grant.id, businessId: input.businessId,
        checkoutOrderId: input.checkoutOrderId, status: "RESERVED", replayed: true };
    }

    if (order.status !== "PENDING" || order.gateway_order_id !== null ||
        order.billing_interval !== "MONTHLY" || Number(order.is_active) !== 1 ||
        Number(order.trial_days) !== 0 || !/^\d+\.\d{2}$/.test(String(order.price_lkr)) ||
        Number(order.price_lkr) <= 0 || String(order.checkout_amount_lkr) !== String(order.price_lkr) ||
        !Number.isSafeInteger(Number(order.invoice_limit)) ||
        Number(order.invoice_limit) < 1 || Number(order.invoice_limit) > 100000 ||
        !(order.expires_at instanceof Date) || !Number.isFinite(order.expires_at.getTime()) ||
        order.expires_at.getTime() <= Date.now()) {
      throw new TrialReservationError("CHECKOUT_NOT_ELIGIBLE");
    }

    // Reject extra open/paid checkouts. A newly-created checkout on this
    // business must NOT be allowed while an active trial reservation exists.
    const [openOrders] = await connection.execute<OpenOrderRow[]>(
      ["SELECT id FROM checkout_orders WHERE business_id = ?",
       "AND status IN ('PENDING','PROCESSING','PAID') FOR UPDATE"].join(" "),
      [input.businessId]
    );
    if (openOrders.length !== 1 || openOrders[0].id !== input.checkoutOrderId) {
      throw new TrialReservationError("OTHER_CHECKOUT_REQUIRES_REVIEW");
    }

    const previousTrials = await count(connection,
      "SELECT COUNT(*) AS n FROM introductory_trial_grants WHERE identity_fingerprint = ?",
      [identity.identity_fingerprint]);
    const previousPromotions = await count(connection,
      ["SELECT COUNT(*) AS n FROM promotion_redemptions pr",
       "JOIN verified_business_identities vbi ON vbi.business_id = pr.business_id",
       "WHERE vbi.identity_fingerprint = ?"].join(" "),
      [identity.identity_fingerprint]);
    const previousSubscriptions = await count(connection,
      ["SELECT COUNT(*) AS n FROM business_subscriptions bs",
       "JOIN verified_business_identities vbi ON vbi.business_id = bs.business_id",
       "WHERE vbi.identity_fingerprint = ?"].join(" "),
      [identity.identity_fingerprint]);

    const decision = assessIntroductoryTrial({
      businessIdentityVerified: true,
      businessStatus: "PENDING",
      currentSubscriptionId: null,
      previousTrialGrantCount: previousTrials,
      previousOtherFreeGrantCount: previousPromotions,
      previousSubscriptionCount: previousSubscriptions,
      paymentAttemptCount: payments,
    });
    if (!decision.eligible) throw new TrialReservationError(decision.code);

    const grantId = randomUUID();
    await connection.execute(
      ["INSERT INTO introductory_trial_grants",
       "(id, business_id, identity_fingerprint, checkout_order_id, status, created_at)",
       "VALUES (?, ?, ?, ?, 'RESERVED', UTC_TIMESTAMP(3))"].join(" "),
      [grantId, input.businessId, identity.identity_fingerprint, input.checkoutOrderId]
    );
    // Unique identity claim is shared with promotional reservations.
    // This prevents concurrent TRIAL vs PROMOTION grants across businesses.
    await connection.execute(
      ["INSERT INTO identity_offer_claims",
       "(identity_fingerprint, business_id, offer_kind, reservation_id, created_at)",
       "VALUES (?, ?, 'TRIAL', ?, UTC_TIMESTAMP(3))"].join(" "),
      [identity.identity_fingerprint, input.businessId, grantId]
    );

    const [updated] = await connection.execute<ResultSetHeader>(
      ["UPDATE checkout_orders SET status = 'CANCELLED', updated_at = UTC_TIMESTAMP(3)",
       "WHERE id = ? AND business_id = ? AND status = 'PENDING'",
       "AND gateway_order_id IS NULL AND expires_at > UTC_TIMESTAMP(3)"].join(" "),
      [input.checkoutOrderId, input.businessId]
    );
    if (updated.affectedRows !== 1) throw new TrialReservationError("CHECKOUT_CANCEL_CONFLICT");

    await connection.commit();
    started = false;
    return { grantId, businessId: input.businessId,
      checkoutOrderId: input.checkoutOrderId, status: "RESERVED", replayed: false };
  } catch (error) {
    if (started) await connection.rollback();
    if (conflict(error)) throw new TrialReservationError("TRIAL_RESERVATION_CONFLICT");
    throw error;
  } finally {
    connection.release();
  }
}
