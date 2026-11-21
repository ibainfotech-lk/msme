import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import {
  findPaymentByCheckoutOrder,
  findPaymentByIdForUpdate,
  findPaymentCheckoutOrderForUpdate,
  getPaymentConnection,
} from "./payment.repository";
import { MockPaymentGateway } from "./gateways/mock-payment.gateway";
import type { VerifyPaymentResult } from "./gateways/payment-gateway.types";
import { assessMockPaymentCompletion } from "./payment-completion.policy";

/**
 * INTERNAL DEVELOPMENT ONLY. No HTTP route or webhook may invoke this service.
 * A real bank requires its own authenticated adapter and reconciliation policy.
 * Any successful mock payment commits its checkout, payment, subscription,
 * entitlement, audit event and business activation in one MySQL transaction.
 * Never grant a trial implicitly on a paid checkout.
 */
export class MockSettlementError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "MockSettlementError";
  }
}

export interface MockSettlementInput {
  businessId: string;
  checkoutOrderId: string;
  paymentId: string;
}

export interface MockSettlementResult extends MockSettlementInput {
  subscriptionId: string;
  replayed: boolean;
}

type ConnectionFactory = () => Promise<PoolConnection>;

interface PreliminaryRow extends RowDataPacket {
  status: string;
  gateway_order_id: string | null;
}

interface SubscriptionPointerRow extends RowDataPacket {
  current_subscription_id: string | null;
}

interface ActivationRow extends RowDataPacket {
  id: string;
}

interface PaidPlanRow extends RowDataPacket {
  id: string;
  billing_interval: string;
  invoice_limit: number;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireOne(result: ResultSetHeader, code: string): void {
  if (result.affectedRows !== 1) {
    throw new MockSettlementError(code);
  }
}

export class MockPaymentSettlementService {
  constructor(
    private readonly gateway: MockPaymentGateway,
    private readonly connectionFactory: ConnectionFactory = getPaymentConnection
  ) {}

  async settle(input: MockSettlementInput): Promise<MockSettlementResult> {
    if (
      process.env.NODE_ENV !== "development" ||
      !(this.gateway instanceof MockPaymentGateway)
    ) {
      throw new MockSettlementError("MOCK_SETTLEMENT_DISABLED");
    }

    if (
      !uuidPattern.test(input.businessId) ||
      !uuidPattern.test(input.checkoutOrderId) ||
      !uuidPattern.test(input.paymentId)
    ) {
      throw new MockSettlementError("INVALID_SETTLEMENT_REFERENCE");
    }

    // Never hold a database transaction open while querying the mock provider.
    // The second read occurs under row locks after provider verification.
    const initialConnection = await this.connectionFactory();
    let initial: PreliminaryRow | undefined;

    try {
      const [rows] = await initialConnection.execute<PreliminaryRow[]>(
        [
          "SELECT status, gateway_order_id",
          "FROM platform_payment_transactions",
          "WHERE id = ? AND business_id = ? AND checkout_order_id = ?",
          "AND gateway = 'MOCK' LIMIT 1",
        ].join(" "),
        [input.paymentId, input.businessId, input.checkoutOrderId]
      );
      initial = rows[0];
    } finally {
      initialConnection.release();
    }

    if (!initial) {
      throw new MockSettlementError("PAYMENT_NOT_FOUND");
    }

    let verification: VerifyPaymentResult | null = null;

    // A committed settlement can replay even after the mock gateway restarts.
    // Database state and the unique activation/payment link are still checked.
    if (initial.status !== "SUCCEEDED") {
      if (
        typeof initial.gateway_order_id !== "string" ||
        !initial.gateway_order_id.startsWith("mock_order_")
      ) {
        throw new MockSettlementError("MOCK_GATEWAY_ORDER_MISSING");
      }

      verification = await this.gateway.verifyPayment({
        gatewayOrderId: initial.gateway_order_id,
      });
    }

    const connection = await this.connectionFactory();
    let inTransaction = false;

    try {
      await connection.beginTransaction();
      inTransaction = true;

      // Lock ordering matches existing code: business -> checkout -> payment.
      const business = await findCheckoutBusinessForUpdate(
        connection, input.businessId
      );
      if (!business) throw new MockSettlementError("BUSINESS_NOT_FOUND");

      const order = await findPaymentCheckoutOrderForUpdate(
        connection, input.checkoutOrderId, input.businessId
      );
      if (!order) throw new MockSettlementError("CHECKOUT_ORDER_NOT_FOUND");

      const payment = await findPaymentByIdForUpdate(
        connection, input.paymentId, input.businessId
      );
      if (!payment || payment.checkout_order_id !== order.id) {
        throw new MockSettlementError("PAYMENT_CONTEXT_MISMATCH");
      }

      const attempts = await findPaymentByCheckoutOrder(connection, order.id);
      if (attempts.length !== 1 || attempts[0].id !== payment.id) {
        throw new MockSettlementError("PAYMENT_ATTEMPTS_RECONCILIATION_REQUIRED");
      }

      const [previous] = await connection.execute<ActivationRow[]>(
        [
          "SELECT id FROM business_subscriptions",
          "WHERE activation_payment_id = ? AND business_id = ? LIMIT 1",
        ].join(" "),
        [payment.id, input.businessId]
      );

      if (payment.status === "SUCCEEDED") {
        if (
          order.status !== "PAID" ||
          payment.gateway !== "MOCK" ||
          !payment.gateway_order_id ||
          payment.gateway_order_id !== order.gateway_order_id ||
          !payment.gateway_transaction_id ||
          !payment.verified_at ||
          previous.length !== 1
        ) {
          throw new MockSettlementError("SETTLED_RECORDS_INCONSISTENT");
        }

        await connection.commit();
        inTransaction = false;
        return { ...input, subscriptionId: previous[0].id, replayed: true };
      }

      if (previous.length !== 0) {
        throw new MockSettlementError("ACTIVATION_ALREADY_LINKED");
      }

      if (business.status !== "PENDING" && business.status !== "ACTIVE") {
        throw new MockSettlementError("BUSINESS_NOT_ELIGIBLE_FOR_ACTIVATION");
      }
      if (!verification) throw new MockSettlementError("VERIFICATION_REQUIRED");

      const assessment = assessMockPaymentCompletion({
        order, payment, verification,
      });
      if (!assessment.eligible) {
        throw new MockSettlementError(assessment.code);
      }

      const [pointers] = await connection.execute<SubscriptionPointerRow[]>(
        "SELECT current_subscription_id FROM businesses WHERE id = ? LIMIT 1",
        [input.businessId]
      );

      if (pointers.length !== 1 || pointers[0].current_subscription_id !== null) {
        throw new MockSettlementError("EXISTING_SUBSCRIPTION_REQUIRES_REVIEW");
      }

      const [plans] = await connection.execute<PaidPlanRow[]>(
        [
          "SELECT id, billing_interval, invoice_limit FROM subscription_plans",
          "WHERE id = ? LIMIT 1",
        ].join(" "),
        [order.plan_id]
      );

      const plan = plans[0];
      if (
        !plan ||
        plan.billing_interval !== "MONTHLY" ||
        !Number.isInteger(Number(plan.invoice_limit)) ||
        Number(plan.invoice_limit) < 1 ||
        Number(plan.invoice_limit) > 100000
      ) {
        throw new MockSettlementError("INVALID_SUBSCRIPTION_PLAN");
      }

      const intervalSql = "1 MONTH";
      const invoiceLimit = Number(plan.invoice_limit);
      const subscriptionId = randomUUID();

      const [paymentUpdate] = await connection.execute<ResultSetHeader>(
        [
          "UPDATE platform_payment_transactions SET status = 'SUCCEEDED',",
          "gateway_transaction_id = ?, verified_at = ?,",
          "updated_at = UTC_TIMESTAMP(3)",
          "WHERE id = ? AND business_id = ? AND status = 'PENDING'",
          "AND initiation_status = 'INITIATED'",
          "AND gateway_transaction_id IS NULL AND verified_at IS NULL",
        ].join(" "),
        [
          assessment.gatewayTransactionId,
          assessment.verifiedAt,
          payment.id,
          input.businessId,
        ]
      );
      requireOne(paymentUpdate, "PAYMENT_SETTLEMENT_CONFLICT");

      const [checkoutUpdate] = await connection.execute<ResultSetHeader>(
        [
          "UPDATE checkout_orders SET status = 'PAID',",
          "updated_at = UTC_TIMESTAMP(3)",
          "WHERE id = ? AND business_id = ? AND status = 'PROCESSING'",
          "AND gateway_order_id = ?",
        ].join(" "),
        [order.id, input.businessId, verification.gatewayOrderId]
      );
      requireOne(checkoutUpdate, "CHECKOUT_SETTLEMENT_CONFLICT");

      await connection.execute(
        [
          "INSERT INTO business_subscriptions",
          "(id, business_id, plan_id, status, starts_at,",
          "current_period_start, current_period_end,",
          "activation_payment_id, created_at, updated_at)",
          "VALUES (?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3),",
          "DATE_ADD(UTC_TIMESTAMP(3), INTERVAL " + intervalSql + "),",
          "?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        ].join(" "),
        [subscriptionId, input.businessId, order.plan_id, payment.id]
      );

      const [entitlements] = await connection.execute<ResultSetHeader>(
        [
          "INSERT INTO subscription_entitlements",
          "(id, subscription_id, feature_key, is_enabled,",
          "usage_limit, warning_threshold, period_start, period_end,",
          "created_at, updated_at)",
          "SELECT ?, id, 'invoices.monthly', 1, ?, ?,",
          "current_period_start, current_period_end,",
          "UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)",
          "FROM business_subscriptions WHERE id = ? AND business_id = ?",
        ].join(" "),
        [
          randomUUID(), invoiceLimit, Math.max(0, invoiceLimit - 2),
          subscriptionId, input.businessId,
        ]
      );
      requireOne(entitlements, "ENTITLEMENT_CREATION_FAILED");

      const [events] = await connection.execute<ResultSetHeader>(
        [
          "INSERT INTO subscription_events",
          "(id, subscription_id, event_type, previous_status,",
          "new_status, description, metadata, occurred_at)",
          "VALUES (?, ?, 'ACTIVATED', 'PENDING', 'ACTIVE',",
          "'Verified mock payment activation', ?, UTC_TIMESTAMP(3))",
        ].join(" "),
        [
          randomUUID(), subscriptionId,
          JSON.stringify({
            paymentId: payment.id,
            checkoutOrderId: order.id,
            gateway: "MOCK",
          }),
        ]
      );
      requireOne(events, "ACTIVATION_EVENT_CREATION_FAILED");

      const [businessUpdate] = await connection.execute<ResultSetHeader>(
        [
          "UPDATE businesses SET status = 'ACTIVE',",
          "current_subscription_id = ?, updated_at = UTC_TIMESTAMP(3)",
          "WHERE id = ? AND status IN ('PENDING', 'ACTIVE')",
          "AND current_subscription_id IS NULL",
        ].join(" "),
        [subscriptionId, input.businessId]
      );
      requireOne(businessUpdate, "BUSINESS_ACTIVATION_CONFLICT");

      await connection.commit();
      inTransaction = false;
      return { ...input, subscriptionId, replayed: false };
    } catch (error) {
      if (inTransaction) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error("[MOCK SETTLEMENT] Rollback failed:", rollbackError);
        }
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
