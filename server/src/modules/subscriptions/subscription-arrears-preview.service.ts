import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { hasPaymentBillingPermission } from "../payments/payment.repository";
import {
  quoteMonthlyArrears,
  type MonthlyDueRecord,
  type MonthlyArrearsQuote,
  type VerifiedDueAllocation,
} from "./subscription-arrears.policy";

/**
 * F.16.5.4a INTERNAL READ-ONLY monthly arrears preview.
 * No route invokes this service. No automatic dues, payment transactions,
 * subscription changes, checkout creation, or gateway calls are performed.
 * A trusted, backfilled month-by-month ledger is required to enable it.
 */
export class ArrearsPreviewError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "ArrearsPreviewError";
  }
}

export interface ArrearsPreviewInput {
  businessId: string;
  subscriptionId: string;
  userId: string;
  asOf: Date;
}

interface SubscriptionRow extends RowDataPacket {
  starts_at: Date | null;
  status: string;
}
interface MonthlyDueRow extends RowDataPacket {
  id: string;
  billing_month: string;
  due_at: Date;
  charge_lkr: string;
  waived_lkr: string;
  status: "OPEN" | "SETTLED" | "WAIVED" | "VOID";
}
interface AllocationRow extends RowDataPacket {
  monthly_due_id: string;
  payment_id: string;
  amount_lkr: string;
  payment_amount_lkr: string;
  payment_total_allocated_lkr: string;
  payment_status: string;
  payment_verified_at: Date | null;
}

type ConnectionFactory = () => Promise<PoolConnection>;
// Deliberately use the exact UUID parser below, rather than trusting HTTP inputs.
const strictUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function previewMonthlySubscriptionArrears(
  input: ArrearsPreviewInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<MonthlyArrearsQuote> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_ARREARS_PREVIEW_ENABLED !== "true") {
    throw new ArrearsPreviewError("ARREARS_PREVIEW_DISABLED", 403);
  }
  if (process.env.NOTETO_ARREARS_HISTORY_READY !== "true") {
    throw new ArrearsPreviewError("ARREARS_HISTORY_NOT_READY", 503);
  }
  if (!strictUuid.test(input.businessId) ||
      !strictUuid.test(input.subscriptionId) ||
      !strictUuid.test(input.userId) ||
      !(input.asOf instanceof Date) || !Number.isFinite(input.asOf.getTime())) {
    throw new ArrearsPreviewError("INVALID_ARREARS_REFERENCE", 400);
  }

  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || (business.status !== "ACTIVE" && business.status !== "SUSPENDED")) {
      throw new ArrearsPreviewError("BUSINESS_NOT_BILLABLE");
    }
    if (!(await hasPaymentBillingPermission(connection, input.businessId, input.userId))) {
      throw new ArrearsPreviewError("BILLING_PERMISSION_DENIED", 403);
    }

    const [subscriptions] = await connection.execute<SubscriptionRow[]>(
      "SELECT status, starts_at FROM business_subscriptions WHERE id = ? AND business_id = ? FOR UPDATE",
      [input.subscriptionId, input.businessId]
    );
    const subscription = subscriptions[0];
    if (!subscription ||
        !["ACTIVE", "PAST_DUE", "TRIALING"].includes(subscription.status) ||
        !(subscription.starts_at instanceof Date) ||
        !Number.isFinite(subscription.starts_at.getTime())) {
      throw new ArrearsPreviewError("SUBSCRIPTION_REQUIRES_REVIEW");
    }

    const [dueRows] = await connection.execute<MonthlyDueRow[]>(
      [
        "SELECT id, DATE_FORMAT(billing_month, '%Y-%m-01') AS billing_month,",
        "due_at, charge_lkr, waived_lkr, status",
        "FROM subscription_monthly_dues",
        "WHERE business_id = ? AND subscription_id = ?",
        "ORDER BY billing_month",
      ].join(" "),
      [input.businessId, input.subscriptionId]
    );
    const [allocationRows] = await connection.execute<AllocationRow[]>(
      [
        "SELECT a.monthly_due_id, a.payment_id, a.amount_lkr,",
        "p.amount_lkr AS payment_amount_lkr, p.status AS payment_status,",
        "p.verified_at AS payment_verified_at,",
        "(SELECT COALESCE(SUM(a2.amount_lkr), 0.00) FROM subscription_due_allocations a2",
        "WHERE a2.business_id = a.business_id AND a2.payment_id = a.payment_id)",
        "AS payment_total_allocated_lkr",
        "FROM subscription_due_allocations a",
        "JOIN subscription_monthly_dues d",
        "ON d.id = a.monthly_due_id AND d.business_id = a.business_id",
        "JOIN platform_payment_transactions p",
        "ON p.id = a.payment_id AND p.business_id = a.business_id",
        "WHERE d.business_id = ? AND d.subscription_id = ?",
      ].join(" "),
      [input.businessId, input.subscriptionId]
    );

    const allocations = new Map<string, VerifiedDueAllocation[]>();
    for (const row of allocationRows) {
      const list = allocations.get(row.monthly_due_id) ?? [];
      list.push({
        paymentId: row.payment_id,
        amountLkr: String(row.amount_lkr),
        paymentAmountLkr: String(row.payment_amount_lkr),
        paymentTotalAllocatedLkr: String(row.payment_total_allocated_lkr),
        paymentStatus: row.payment_status,
        paymentVerifiedAt: row.payment_verified_at,
      });
      allocations.set(row.monthly_due_id, list);
    }

    const records: MonthlyDueRecord[] = dueRows.map(row => ({
      billingMonth: row.billing_month,
      dueAt: row.due_at,
      chargeLkr: String(row.charge_lkr),
      waivedLkr: String(row.waived_lkr),
      status: row.status,
      allocations: allocations.get(row.id) ?? [],
    }));

    const quote = quoteMonthlyArrears(subscription.starts_at, records, input.asOf);
    await connection.commit();
    started = false;
    return quote;
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
