import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { hasPaymentBillingPermission } from "../payments/payment.repository";

/**
 * F.16.5.4b INTERNAL DEVELOPMENT ONLY: allocate an ALREADY VERIFIED
 * platform payment to an ALREADY REVIEWED monthly due.
 *
 * NO HTTP route, automatic due creation, gateway initiation, capture,
 * charge, refund, subscription activation, entitlement or business status
 * change. Not intended for production until all payment and historical
 * billing evidence has been reconciled.
 */
export class VerifiedDueAllocationError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "VerifiedDueAllocationError";
  }
}

export interface AllocateVerifiedDuePaymentInput {
  businessId: string;
  subscriptionId: string;
  monthlyDueId: string;
  paymentId: string;
  userId: string;
  amountLkr: string;
}

export interface AllocateVerifiedDuePaymentResult {
  allocationId: string;
  dueStatus: "OPEN" | "SETTLED";
  dueOutstandingLkr: string;
  replayed: boolean;
  paymentInitiated: false;
}

interface SubscriptionRow extends RowDataPacket { id: string; status: string }
interface PaymentRow extends RowDataPacket {
  id: string;
  amount_lkr: string;
  status: string;
  initiation_status: string;
  verified_at: Date | null;
  gateway_transaction_id: string | null;
  checkout_status: string;
}
interface DueRow extends RowDataPacket {
  id: string;
  status: "OPEN" | "SETTLED" | "WAIVED" | "VOID";
  charge_lkr: string;
  waived_lkr: string;
  due_at: Date;
}
interface AllocationRow extends RowDataPacket { id: string; amount_lkr: string }
interface SumRow extends RowDataPacket { allocated_lkr: string }
type ConnectionFactory = () => Promise<PoolConnection>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = /^(?:0|[1-9][0-9]{0,9})\.\d{2}$/;

function toCents(value: string): number {
  if (typeof value !== "string" || !money.test(value)) {
    throw new VerifiedDueAllocationError("INVALID_ALLOCATION_AMOUNT", 400);
  }
  const [major, minor] = value.split(".");
  const cents = Number(major) * 100 + Number(minor);
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new VerifiedDueAllocationError("INVALID_ALLOCATION_AMOUNT", 400);
  }
  return cents;
}
function fromCents(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VerifiedDueAllocationError("PAYMENT_RECONCILIATION_REQUIRED");
  }
  return String(Math.floor(value / 100)) + "." + String(value % 100).padStart(2, "0");
}
function isSqlConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(String(error.code));
}

export async function allocateVerifiedMonthlyPayment(
  input: AllocateVerifiedDuePaymentInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<AllocateVerifiedDuePaymentResult> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_DUE_ALLOCATION_ENABLED !== "true") {
    throw new VerifiedDueAllocationError("DUE_ALLOCATION_DISABLED", 403);
  }
  if (process.env.NOTETO_ARREARS_HISTORY_READY !== "true" ||
      process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY !== "true") {
    throw new VerifiedDueAllocationError("PAYMENT_OR_BILLING_HISTORY_NOT_READY", 503);
  }
  if (!uuid.test(input.businessId) || !uuid.test(input.subscriptionId) ||
      !uuid.test(input.monthlyDueId) || !uuid.test(input.paymentId) ||
      !uuid.test(input.userId)) {
    throw new VerifiedDueAllocationError("INVALID_ALLOCATION_REFERENCE", 400);
  }
  const requested = toCents(input.amountLkr);
  if (requested === 0) {
    throw new VerifiedDueAllocationError("INVALID_ALLOCATION_AMOUNT", 400);
  }

  const connection = await getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // Existing settlement lock order begins with business. This lock also
    // serializes all monthly allocations for a single business.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || !["ACTIVE", "SUSPENDED"].includes(business.status)) {
      throw new VerifiedDueAllocationError("BUSINESS_NOT_BILLABLE");
    }
    if (!(await hasPaymentBillingPermission(connection, input.businessId, input.userId))) {
      throw new VerifiedDueAllocationError("BILLING_PERMISSION_DENIED", 403);
    }

    const [subscriptions] = await connection.execute<SubscriptionRow[]>(
      "SELECT id, status FROM business_subscriptions WHERE id = ? AND business_id = ? FOR UPDATE",
      [input.subscriptionId, input.businessId]
    );
    if (subscriptions.length !== 1 ||
        !["ACTIVE", "PAST_DUE"].includes(subscriptions[0].status)) {
      throw new VerifiedDueAllocationError("SUBSCRIPTION_REQUIRES_REVIEW");
    }

    const [payments] = await connection.execute<PaymentRow[]>(
      [
        "SELECT p.id, p.amount_lkr, p.status, p.initiation_status,",
        "p.verified_at, p.gateway_transaction_id,",
        "co.status AS checkout_status",
        "FROM platform_payment_transactions p",
        "INNER JOIN checkout_orders co ON co.id = p.checkout_order_id",
        "AND co.business_id = p.business_id",
        "WHERE p.business_id = ? AND p.id = ? FOR UPDATE",
      ].join(" "),
      [input.businessId, input.paymentId]
    );
    const payment = payments[0];
    if (!payment || payment.status !== "SUCCEEDED" ||
        payment.initiation_status !== "INITIATED" ||
        payment.checkout_status !== "PAID" ||
        typeof payment.gateway_transaction_id !== "string" ||
        payment.gateway_transaction_id.length === 0 ||
        !(payment.verified_at instanceof Date) ||
        !Number.isFinite(payment.verified_at.getTime()) ||
        payment.verified_at.getTime() > Date.now()) {
      throw new VerifiedDueAllocationError("PAYMENT_VERIFICATION_REQUIRED");
    }

    const [dues] = await connection.execute<DueRow[]>(
      [
        "SELECT id, status, charge_lkr, waived_lkr, due_at",
        "FROM subscription_monthly_dues",
        "WHERE id = ? AND business_id = ? AND subscription_id = ? FOR UPDATE",
      ].join(" "),
      [input.monthlyDueId, input.businessId, input.subscriptionId]
    );
    const due = dues[0];
    if (!due || !["OPEN", "SETTLED"].includes(due.status) ||
        !(due.due_at instanceof Date) ||
        !Number.isFinite(due.due_at.getTime()) ||
        due.due_at.getTime() > Date.now()) {
      throw new VerifiedDueAllocationError("DUE_NOT_ELIGIBLE");
    }

    const owed = toCents(String(due.charge_lkr)) - toCents(String(due.waived_lkr));
    const paymentTotal = toCents(String(payment.amount_lkr));
    if (owed <= 0 || paymentTotal <= 0) {
      throw new VerifiedDueAllocationError("PAYMENT_RECONCILIATION_REQUIRED");
    }

    const [existing] = await connection.execute<AllocationRow[]>(
      "SELECT id, amount_lkr FROM subscription_due_allocations WHERE business_id = ? AND monthly_due_id = ? AND payment_id = ? FOR UPDATE",
      [input.businessId, input.monthlyDueId, input.paymentId]
    );

    const [paidOnDueRows] = await connection.execute<SumRow[]>(
      "SELECT COALESCE(SUM(amount_lkr), 0.00) AS allocated_lkr FROM subscription_due_allocations WHERE business_id = ? AND monthly_due_id = ?",
      [input.businessId, input.monthlyDueId]
    );
    const [usedPaymentRows] = await connection.execute<SumRow[]>(
      "SELECT COALESCE(SUM(amount_lkr), 0.00) AS allocated_lkr FROM subscription_due_allocations WHERE business_id = ? AND payment_id = ?",
      [input.businessId, input.paymentId]
    );
    const paidOnDue = toCents(String(paidOnDueRows[0].allocated_lkr));
    const usedPayment = toCents(String(usedPaymentRows[0].allocated_lkr));

    if (paidOnDue > owed || usedPayment > paymentTotal ||
        (due.status === "SETTLED" && paidOnDue !== owed) ||
        (due.status === "OPEN" && paidOnDue === owed)) {
      throw new VerifiedDueAllocationError("PAYMENT_RECONCILIATION_REQUIRED");
    }

    if (existing.length !== 0) {
      if (existing.length !== 1 ||
          toCents(String(existing[0].amount_lkr)) !== requested) {
        throw new VerifiedDueAllocationError("ALLOCATION_IDEMPOTENCY_CONFLICT");
      }
      const remaining = owed - paidOnDue;
      await connection.commit();
      transactionStarted = false;
      return {
        allocationId: existing[0].id,
        dueStatus: due.status as "OPEN" | "SETTLED",
        dueOutstandingLkr: fromCents(remaining),
        replayed: true,
        paymentInitiated: false,
      };
    }

    if (requested > owed - paidOnDue || requested > paymentTotal - usedPayment) {
      throw new VerifiedDueAllocationError("ALLOCATION_EXCEEDS_VERIFIED_FUNDS");
    }
    const allocationId = randomUUID();
    await connection.execute(
      [
        "INSERT INTO subscription_due_allocations",
        "(id, business_id, monthly_due_id, payment_id, amount_lkr)",
        "VALUES (?, ?, ?, ?, ?)",
      ].join(" "),
      [allocationId, input.businessId, input.monthlyDueId, input.paymentId, input.amountLkr]
    );

    const remaining = owed - paidOnDue - requested;
    const newDueStatus = remaining === 0 ? "SETTLED" : "OPEN";
    if (newDueStatus === "SETTLED") {
      const [updated] = await connection.execute<ResultSetHeader>(
        "UPDATE subscription_monthly_dues SET status = 'SETTLED' WHERE id = ? AND business_id = ? AND status = 'OPEN'",
        [input.monthlyDueId, input.businessId]
      );
      if (updated.affectedRows !== 1) {
        throw new VerifiedDueAllocationError("DUE_STATUS_CONFLICT");
      }
    }

    await connection.commit();
    transactionStarted = false;
    return {
      allocationId,
      dueStatus: newDueStatus,
      dueOutstandingLkr: fromCents(remaining),
      replayed: false,
      paymentInitiated: false,
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    if (isSqlConflict(error)) {
      throw new VerifiedDueAllocationError("DUE_ALLOCATION_CONCURRENCY_CONFLICT");
    }
    throw error;
  } finally {
    connection.release();
  }
}
