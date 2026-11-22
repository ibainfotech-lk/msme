import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "./checkout.repository";
import { assessCheckoutRecovery, type RecoveryAction } from "./checkout-recovery.policy";
import {
  findPaymentCheckoutOrderForUpdate,
  findPaymentByCheckoutOrder,
  hasPaymentBillingPermission,
} from "../payments/payment.repository";

/**
 * F.16.5.4a — INTERNAL, read-only recovery inspection. No API route invokes it.
 * No checkout/payment row changes, payment initiation, subscription activation,
 * invoice posting or bank calls. The decision is NOT permission to charge.
 */
export class CheckoutRecoveryPreviewError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "CheckoutRecoveryPreviewError";
  }
}

export interface CheckoutRecoveryPreviewInput {
  businessId: string;
  checkoutOrderId: string;
  userId: string;
}

export interface CheckoutRecoveryPreview {
  businessId: string;
  checkoutOrderId: string;
  action: RecoveryAction;
  recordedPaymentAttempts: number;
  paymentActionAllowed: false;
}

interface IdRow extends RowDataPacket { id: string }
type ConnectionFactory = () => Promise<PoolConnection>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function previewCheckoutRecovery(
  input: CheckoutRecoveryPreviewInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<CheckoutRecoveryPreview> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_CHECKOUT_RECOVERY_PREVIEW_ENABLED !== "true") {
    throw new CheckoutRecoveryPreviewError("CHECKOUT_RECOVERY_PREVIEW_DISABLED", 403);
  }
  if (!uuid.test(input.businessId) || !uuid.test(input.checkoutOrderId) ||
      !uuid.test(input.userId)) {
    throw new CheckoutRecoveryPreviewError("INVALID_CHECKOUT_RECOVERY_REFERENCE", 400);
  }
  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;

    // Preserve existing settlement lock ordering: business -> order -> payment.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || !["PENDING", "ACTIVE"].includes(business.status)) {
      throw new CheckoutRecoveryPreviewError("BUSINESS_ACCESS_DENIED", 403);
    }
    if (!(await hasPaymentBillingPermission(connection, input.businessId, input.userId))) {
      throw new CheckoutRecoveryPreviewError("BILLING_PERMISSION_DENIED", 403);
    }

    const checkout = await findPaymentCheckoutOrderForUpdate(
      connection, input.checkoutOrderId, input.businessId
    );
    if (!checkout) throw new CheckoutRecoveryPreviewError("CHECKOUT_NOT_FOUND", 404);

    const payments = await findPaymentByCheckoutOrder(connection, input.checkoutOrderId);
    const [openOrders] = await connection.execute<IdRow[]>(
      [
        "SELECT id FROM checkout_orders WHERE business_id = ?",
        "AND status IN ('PENDING','PROCESSING','PAID') ORDER BY id",
      ].join(" "),
      [input.businessId]
    );
    const [trialReservations] = await connection.execute<IdRow[]>(
      "SELECT id FROM introductory_trial_grants WHERE business_id = ? AND status = 'RESERVED' LIMIT 1",
      [input.businessId]
    );
    const [promotionReservations] = await connection.execute<IdRow[]>(
      "SELECT id FROM promotion_redemptions WHERE business_id = ? AND reservation_status = 'RESERVED' LIMIT 1",
      [input.businessId]
    );

    let action: RecoveryAction;
    if (trialReservations.length || promotionReservations.length ||
        (checkout.gateway_order_id !== null && checkout.status !== "PAID") ||
        openOrders.length > 1) {
      action = "RECONCILIATION_REQUIRED";
    } else {
      action = assessCheckoutRecovery({
        checkoutStatus: checkout.status as "PENDING" | "PROCESSING" |
          "PAID" | "FAILED" | "CANCELLED" | "EXPIRED",
        expiresAt: checkout.expires_at,
        attempts: payments.map(p => ({
          status: p.status as "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED",
          initiationStatus: p.initiation_status,
        })),
      }, new Date()).action;
    }

    const result: CheckoutRecoveryPreview = {
      businessId: input.businessId,
      checkoutOrderId: input.checkoutOrderId,
      action,
      recordedPaymentAttempts: payments.length,
      paymentActionAllowed: false,
    };
    await connection.commit();
    started = false;
    return result;
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
