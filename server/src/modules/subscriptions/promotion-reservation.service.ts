import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { hasPaymentBillingPermission } from "../payments/payment.repository";
import { assessPromotion } from "./trial-promotion.policy";

/**
 * F.16.5.3 INTERNAL DEVELOPMENT ONLY. This is a reservation, NOT activation.
 * No route or webhook calls this service. It does not create subscriptions,
 * entitlements, successful payments, invoices or ACTIVE businesses.
 * Only a trusted administrative workflow may populate verified identities.
 * The identity-history flags MUST remain false outside reviewed CI fixtures
 * until all historic identities and grants are reconciled.
 */
export class PromotionReservationError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "PromotionReservationError";
  }
}

export interface ReservePromotionInput {
  businessId: string;
  checkoutOrderId: string;
  userId: string;
  promotionCode: string;
}

export interface ReservedPromotion {
  redemptionId: string;
  businessId: string;
  checkoutOrderId: string;
  promotionCodeId: string;
  freeMonths: 1 | 3 | 6;
  status: "RESERVED";
  replayed: boolean;
}

type ConnectionFactory = () => Promise<PoolConnection>;
interface BusinessPointerRow extends RowDataPacket { current_subscription_id: string | null }
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
interface PromotionRow extends RowDataPacket {
  id: string;
  status: "ACTIVE" | "INACTIVE" | "EXPIRED";
  free_months: number;
  max_redemptions: number | null;
  redemption_count: number;
  starts_at: Date | null;
  expires_at: Date | null;
}
interface RedemptionRow extends RowDataPacket {
  id: string;
  promotion_code_id: string;
  checkout_order_id: string | null;
  identity_fingerprint: string | null;
  free_months_granted: number;
  reservation_status: string;
}
interface ClaimRow extends RowDataPacket { offer_kind: string; reservation_id: string; business_id: string }
interface CountRow extends RowDataPacket { n: number }
interface IdRow extends RowDataPacket { id: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const codePattern = /^[A-Z0-9_-]{3,50}$/;

async function count(connection: PoolConnection, sql: string, params: string[]): Promise<number> {
  const [rows] = await connection.execute<CountRow[]>(sql, params);
  const result = Number(rows[0]?.n);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new PromotionReservationError("INVALID_HISTORY_COUNT");
  }
  return result;
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ER_DUP_ENTRY" || error.code === "ER_LOCK_DEADLOCK" ||
     error.code === "ER_LOCK_WAIT_TIMEOUT");
}

/**
 * Atomically record a single free-month offer reservation, consume one
 * promotional quota unit, claim the identity across ALL free-offer types,
 * and cancel the unpaid checkout. Any failure rolls back all four changes.
 *
 * A replay of the same RESERVED row is read-only and never consumes quota.
 * In all cases the business stays PENDING with no subscription or entitlement.
 */
export async function reservePromotion(
  input: ReservePromotionInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<ReservedPromotion> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_PROMOTION_RESERVATIONS_ENABLED !== "true") {
    throw new PromotionReservationError("PROMOTION_RESERVATION_DISABLED", 403);
  }
  if (process.env.NOTETO_PROMOTION_IDENTITY_HISTORY_READY !== "true" ||
      process.env.NOTETO_TRIAL_IDENTITY_HISTORY_READY !== "true") {
    throw new PromotionReservationError("IDENTITY_HISTORY_NOT_READY", 503);
  }
  if (!uuid.test(input.businessId) || !uuid.test(input.checkoutOrderId) ||
      !uuid.test(input.userId) || !codePattern.test(input.promotionCode)) {
    throw new PromotionReservationError("INVALID_PROMOTION_REFERENCE", 400);
  }

  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;

    // Match checkout and settlement: business -> checkout -> other state.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || business.status !== "PENDING") {
      throw new PromotionReservationError("BUSINESS_NOT_PENDING");
    }
    if (!(await hasPaymentBillingPermission(connection, input.businessId, input.userId))) {
      throw new PromotionReservationError("BILLING_PERMISSION_DENIED", 403);
    }

    const [pointers] = await connection.execute<BusinessPointerRow[]>(
      "SELECT current_subscription_id FROM businesses WHERE id = ? LIMIT 1",
      [input.businessId]
    );
    if (pointers.length !== 1 || pointers[0].current_subscription_id !== null) {
      throw new PromotionReservationError("SUBSCRIPTION_ALREADY_EXISTS");
    }

    const [identities] = await connection.execute<IdentityRow[]>(
      ["SELECT identity_fingerprint, verified_at, revoked_at",
       "FROM verified_business_identities WHERE business_id = ? FOR UPDATE"].join(" "),
      [input.businessId]
    );
    const identity = identities[0];
    if (identities.length !== 1 || !identity ||
        !sha256.test(identity.identity_fingerprint) || identity.revoked_at !== null ||
        !(identity.verified_at instanceof Date) ||
        !Number.isFinite(identity.verified_at.getTime()) ||
        identity.verified_at.getTime() > Date.now()) {
      throw new PromotionReservationError("BUSINESS_IDENTITY_NOT_VERIFIED");
    }

    const [orders] = await connection.execute<OrderRow[]>(
      ["SELECT co.id, co.status, co.gateway_order_id, co.expires_at,",
       "co.amount_lkr AS checkout_amount_lkr, sp.price_lkr, sp.billing_interval,",
       "sp.trial_days, sp.is_active, sp.invoice_limit",
       "FROM checkout_orders co JOIN subscription_plans sp ON sp.id = co.plan_id",
       "WHERE co.id = ? AND co.business_id = ? FOR UPDATE"].join(" "),
      [input.checkoutOrderId, input.businessId]
    );
    const order = orders[0];
    if (!order) throw new PromotionReservationError("CHECKOUT_NOT_FOUND", 404);

    // Promotion row is locked to serialize redemptions and enforce quota.
    const [promotions] = await connection.execute<PromotionRow[]>(
      ["SELECT id, status, free_months, max_redemptions, redemption_count, starts_at, expires_at",
       "FROM promotion_codes WHERE code = ? FOR UPDATE"].join(" "),
      [input.promotionCode]
    );
    const promotion = promotions[0];
    if (!promotion) throw new PromotionReservationError("PROMOTION_NOT_FOUND", 404);

    const [existing] = await connection.execute<RedemptionRow[]>(
      ["SELECT id, promotion_code_id, checkout_order_id, identity_fingerprint,",
       "free_months_granted, reservation_status",
       "FROM promotion_redemptions WHERE business_id = ? FOR UPDATE"].join(" "),
      [input.businessId]
    );

    // Even an unsuccessful payment attempt requires reconciliation first.
    const payments = await count(connection,
      ["SELECT COUNT(*) AS n FROM platform_payment_transactions ppt",
       "JOIN verified_business_identities vbi ON vbi.business_id = ppt.business_id",
       "WHERE vbi.identity_fingerprint = ?"].join(" "),
      [identity.identity_fingerprint]
    );
    if (payments !== 0) throw new PromotionReservationError("PAYMENT_RECONCILIATION_REQUIRED");

    const [claims] = await connection.execute<ClaimRow[]>(
      ["SELECT offer_kind, reservation_id, business_id FROM identity_offer_claims",
       "WHERE identity_fingerprint = ? LIMIT 1"].join(" "),
      [identity.identity_fingerprint]
    );

    // Replay must match the exact original identity, code, order and ledger.
    // It must not increment the quota or re-check a now-expired promotion.
    if (existing.length !== 0) {
      const redemption = existing[0];
      const [otherOpen] = await connection.execute<IdRow[]>(
        "SELECT id FROM checkout_orders WHERE business_id = ? AND status IN ('PENDING','PROCESSING','PAID') FOR UPDATE",
        [input.businessId]
      );
      if (existing.length !== 1 || otherOpen.length !== 0 ||
          redemption.promotion_code_id !== promotion.id ||
          redemption.checkout_order_id !== input.checkoutOrderId ||
          redemption.identity_fingerprint !== identity.identity_fingerprint ||
          redemption.reservation_status !== "RESERVED" ||
          order.status !== "CANCELLED" ||
          claims.length !== 1 || claims[0].offer_kind !== "PROMOTION" ||
          claims[0].reservation_id !== redemption.id ||
          claims[0].business_id !== input.businessId ||
          (redemption.free_months_granted !== 1 && redemption.free_months_granted !== 3 &&
           redemption.free_months_granted !== 6)) {
        throw new PromotionReservationError("PROMOTION_ALREADY_REDEEMED");
      }
      await connection.commit();
      started = false;
      return { redemptionId: redemption.id, businessId: input.businessId,
        checkoutOrderId: input.checkoutOrderId, promotionCodeId: promotion.id,
        freeMonths: redemption.free_months_granted as 1 | 3 | 6,
        status: "RESERVED", replayed: true };
    }

    if (order.status !== "PENDING" || order.gateway_order_id !== null ||
        !(order.expires_at instanceof Date) ||
        !Number.isFinite(order.expires_at.getTime()) ||
        order.expires_at.getTime() <= Date.now() ||
        order.billing_interval !== "MONTHLY" || Number(order.is_active) !== 1 ||
        Number(order.trial_days) !== 0 ||
        !/^\d+\.\d{2}$/.test(String(order.price_lkr)) ||
        Number(order.price_lkr) <= 0 ||
        String(order.checkout_amount_lkr) !== String(order.price_lkr) ||
        !Number.isSafeInteger(Number(order.invoice_limit)) ||
        Number(order.invoice_limit) < 1 || Number(order.invoice_limit) > 100000) {
      throw new PromotionReservationError("CHECKOUT_NOT_ELIGIBLE");
    }

    const [openOrders] = await connection.execute<IdRow[]>(
      ["SELECT id FROM checkout_orders WHERE business_id = ?",
       "AND status IN ('PENDING','PROCESSING','PAID') FOR UPDATE"].join(" "),
      [input.businessId]
    );
    if (openOrders.length !== 1 || openOrders[0].id !== input.checkoutOrderId) {
      throw new PromotionReservationError("OTHER_CHECKOUT_REQUIRES_REVIEW");
    }

    const previousTrials = await count(connection,
      "SELECT COUNT(*) AS n FROM introductory_trial_grants WHERE identity_fingerprint = ?",
      [identity.identity_fingerprint]
    );
    const previousPromotions = await count(connection,
      ["SELECT COUNT(*) AS n FROM promotion_redemptions pr",
       "JOIN verified_business_identities vbi ON vbi.business_id = pr.business_id",
       "WHERE vbi.identity_fingerprint = ?"].join(" "),
      [identity.identity_fingerprint]
    );
    const previousSubscriptions = await count(connection,
      ["SELECT COUNT(*) AS n FROM business_subscriptions bs",
       "JOIN verified_business_identities vbi ON vbi.business_id = bs.business_id",
       "WHERE vbi.identity_fingerprint = ?"].join(" "),
      [identity.identity_fingerprint]
    );
    if (claims.length !== 0) throw new PromotionReservationError("OTHER_FREE_OFFER_ALREADY_GRANTED");

    const decision = assessPromotion({
      businessIdentityVerified: true,
      businessStatus: "PENDING",
      currentSubscriptionId: null,
      previousTrialGrantCount: previousTrials,
      previousOtherFreeGrantCount: previousPromotions,
      previousSubscriptionCount: previousSubscriptions,
      paymentAttemptCount: payments,
    }, {
      status: promotion.status,
      freeMonths: Number(promotion.free_months),
      startsAt: promotion.starts_at,
      expiresAt: promotion.expires_at,
      maxRedemptions: promotion.max_redemptions === null ? null : Number(promotion.max_redemptions),
      redemptionCount: Number(promotion.redemption_count),
      alreadyRedeemedForBusiness: false,
    }, new Date());
    if (!decision.eligible) throw new PromotionReservationError(decision.code);

    const redemptionId = randomUUID();
    await connection.execute(
      ["INSERT INTO promotion_redemptions",
       "(id, promotion_code_id, business_id, free_months_granted, redeemed_at,",
       "identity_fingerprint, checkout_order_id, reservation_status)",
       "VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?, ?, 'RESERVED')"].join(" "),
      [redemptionId, promotion.id, input.businessId, decision.freeMonths,
       identity.identity_fingerprint, input.checkoutOrderId]
    );
    await connection.execute(
      ["INSERT INTO identity_offer_claims",
       "(identity_fingerprint, business_id, offer_kind, reservation_id, created_at)",
       "VALUES (?, ?, 'PROMOTION', ?, UTC_TIMESTAMP(3))"].join(" "),
      [identity.identity_fingerprint, input.businessId, redemptionId]
    );

    const [quotaUpdate] = await connection.execute<ResultSetHeader>(
      ["UPDATE promotion_codes SET redemption_count = redemption_count + 1,",
       "updated_at = UTC_TIMESTAMP(3)",
       "WHERE id = ? AND status = 'ACTIVE' AND free_months IN (1, 3, 6)",
       "AND redemption_count >= 0",
       "AND (max_redemptions IS NULL OR redemption_count < max_redemptions)",
       "AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP(3))",
       "AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))"].join(" "),
      [promotion.id]
    );
    if (quotaUpdate.affectedRows !== 1) throw new PromotionReservationError("PROMOTION_QUOTA_CONFLICT");

    const [checkoutUpdate] = await connection.execute<ResultSetHeader>(
      ["UPDATE checkout_orders SET status = 'CANCELLED', updated_at = UTC_TIMESTAMP(3)",
       "WHERE id = ? AND business_id = ? AND status = 'PENDING'",
       "AND gateway_order_id IS NULL AND expires_at > UTC_TIMESTAMP(3)"].join(" "),
      [input.checkoutOrderId, input.businessId]
    );
    if (checkoutUpdate.affectedRows !== 1) throw new PromotionReservationError("CHECKOUT_CANCEL_CONFLICT");

    await connection.commit();
    started = false;
    return { redemptionId, businessId: input.businessId,
      checkoutOrderId: input.checkoutOrderId, promotionCodeId: promotion.id,
      freeMonths: decision.freeMonths, status: "RESERVED", replayed: false };
  } catch (error) {
    if (started) await connection.rollback();
    if (isConcurrencyConflict(error)) {
      throw new PromotionReservationError("PROMOTION_RESERVATION_CONFLICT");
    }
    throw error;
  } finally {
    connection.release();
  }
}
