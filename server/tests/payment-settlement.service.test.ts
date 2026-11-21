import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, after } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { MockPaymentGateway } from "../src/modules/payments/gateways/mock-payment.gateway";
import { MockPaymentSettlementService, MockSettlementError } from "../src/modules/payments/payment-settlement.service";

const previousEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
after(() => {
  if (previousEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnv;
});

interface FakeState {
  business: { id: string; status: string; current_subscription_id: string | null };
  order: { id: string; business_id: string; plan_id: string; status: string; amount_lkr: string; gateway_order_id: string; is_expired: number };
  payment: {
    id: string; business_id: string; checkout_order_id: string;
    gateway: string; status: string; initiation_status: string;
    amount_lkr: string; gateway_order_id: string;
    merchant_reference: string; gateway_transaction_id: string | null;
    verified_at: Date | null;
  };
  activatedSubscriptionId: string | null;
  entitlementWrites: number;
  eventWrites: number;
}

function clone(state: FakeState): FakeState {
  return structuredClone(state);
}

function setup() {
  const businessId = randomUUID();
  const checkoutOrderId = randomUUID();
  const paymentId = randomUUID();
  const planId = randomUUID();
  const gateway = new MockPaymentGateway();
  const merchantReference = "noteto_" + randomUUID();
  const input = { businessId, checkoutOrderId, paymentId };

  const state: FakeState = {
    business: { id: businessId, status: "PENDING", current_subscription_id: null },
    order: {
      id: checkoutOrderId, business_id: businessId, plan_id: planId,
      status: "PROCESSING", amount_lkr: "499.00",
      gateway_order_id: "", is_expired: 0,
    },
    payment: {
      id: paymentId, business_id: businessId, checkout_order_id: checkoutOrderId,
      gateway: "MOCK", status: "PENDING", initiation_status: "INITIATED",
      amount_lkr: "499.00", gateway_order_id: "",
      merchant_reference: merchantReference, gateway_transaction_id: null,
      verified_at: null,
    },
    activatedSubscriptionId: null,
    entitlementWrites: 0,
    eventWrites: 0,
  };

  let failSql: RegExp | null = null;
  let transaction: FakeState | null = null;
  let rollbacks = 0;
  const executed: string[] = [];

  const fakeConnection = {
    async beginTransaction() {
      assert.equal(transaction, null, "nested transaction");
      transaction = clone(state);
    },
    async commit() {
      assert.notEqual(transaction, null);
      transaction = null;
    },
    async rollback() {
      assert.notEqual(transaction, null);
      const restored = transaction!;
      Object.assign(state, restored);
      transaction = null;
      rollbacks++;
    },
    release() {},
    async execute(sql: string, args: unknown[] = []) {
      assert.equal(typeof sql, "string");
      assert.ok(Array.isArray(args));
      const normalized = sql.replace(/\s+/g, " ").trim();
      executed.push(normalized);
      if (failSql?.test(normalized)) throw new Error("SIMULATED_DATABASE_WRITE_FAILURE");

      if (normalized.startsWith("SELECT status, gateway_order_id FROM platform_payment_transactions")) {
        if (args[0] !== state.payment.id ||
            args[1] !== state.payment.business_id ||
            args[2] !== state.payment.checkout_order_id) return [[], []];
        return [[{ status: state.payment.status, gateway_order_id: state.payment.gateway_order_id }], []];
      }
      if (normalized.startsWith("SELECT id, status FROM businesses") && normalized.includes("FOR UPDATE")) {
        return [args[0] === state.business.id ? [{ id: state.business.id, status: state.business.status }] : [], []];
      }
      if (normalized.includes("FROM checkout_orders") && normalized.includes("FOR UPDATE")) {
        return [[state.order], []];
      }
      if (normalized.includes("FROM platform_payment_transactions") && normalized.includes("FOR UPDATE")) {
        return [[state.payment], []];
      }
      if (normalized.includes("FROM platform_payment_transactions") &&
          normalized.includes("WHERE checkout_order_id")) {
        return [[state.payment], []];
      }
      if (normalized.includes("FROM business_subscriptions") && normalized.includes("activation_payment_id")) {
        return [state.activatedSubscriptionId ? [{ id: state.activatedSubscriptionId }] : [], []];
      }
      if (normalized.startsWith("SELECT current_subscription_id FROM businesses")) {
        return [[{ current_subscription_id: state.business.current_subscription_id }], []];
      }
      if (normalized.startsWith("SELECT id, billing_interval, invoice_limit FROM subscription_plans")) {
        return [[{ id: planId, billing_interval: "MONTHLY", invoice_limit: 30 }], []];
      }
      if (normalized.startsWith("UPDATE platform_payment_transactions")) {
        assert.equal(args[2], paymentId);
        state.payment.status = "SUCCEEDED";
        state.payment.gateway_transaction_id = String(args[0]);
        state.payment.verified_at = args[1] as Date;
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE checkout_orders")) {
        state.order.status = "PAID";
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO business_subscriptions")) {
        state.activatedSubscriptionId = String(args[0]);
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO subscription_entitlements")) {
        state.entitlementWrites++;
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO subscription_events")) {
        state.eventWrites++;
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE businesses")) {
        state.business.status = "ACTIVE";
        state.business.current_subscription_id = String(args[0]);
        return [{ affectedRows: 1 }, []];
      }
      throw new Error("UNEXPECTED_SQL: " + normalized);
    },
  } as unknown as PoolConnection;

  const service = new MockPaymentSettlementService(
    gateway, async () => fakeConnection
  );

  return {
    state, gateway, service, input, executed,
    get rollbacks() { return rollbacks; },
    setFailure(pattern: RegExp | null) { failSql = pattern; },
    async initializeGateway(outcome: "SUCCEEDED" | "FAILED" | "CANCELLED" | "PENDING" = "SUCCEEDED") {
      const result = await gateway.initiatePayment({
        checkoutOrderId, businessId, merchantReference,
        amountLkr: "499.00", currency: "LKR", description: "Noteto test",
      });
      state.order.gateway_order_id = result.gatewayOrderId;
      state.payment.gateway_order_id = result.gatewayOrderId;
      if (outcome !== "PENDING") {
        gateway.setTestOutcome(result.gatewayOrderId, outcome);
      }
    },
  };
}

test("verified mock payment activates exactly one paid subscription transaction", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  const result = await ctx.service.settle(ctx.input);
  assert.equal(result.replayed, false);
  assert.equal(ctx.state.payment.status, "SUCCEEDED");
  assert.equal(ctx.state.order.status, "PAID");
  assert.equal(ctx.state.business.status, "ACTIVE");
  assert.equal(ctx.state.business.current_subscription_id, result.subscriptionId);
  assert.equal(ctx.state.activatedSubscriptionId, result.subscriptionId);
  assert.equal(ctx.state.entitlementWrites, 1);
  assert.equal(ctx.state.eventWrites, 1);
  const businessLock = ctx.executed.findIndex(s =>
    s.includes("FROM businesses") && s.includes("FOR UPDATE"));
  const checkoutLock = ctx.executed.findIndex(s =>
    s.includes("FROM checkout_orders") && s.includes("FOR UPDATE"));
  const paymentLock = ctx.executed.findIndex(s =>
    s.includes("FROM platform_payment_transactions") && s.includes("FOR UPDATE"));
  assert.ok(0 <= businessLock && businessLock < checkoutLock && checkoutLock < paymentLock);
});

test("replay is idempotent and never creates another subscription", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  const first = await ctx.service.settle(ctx.input);
  const second = await ctx.service.settle(ctx.input);
  assert.equal(second.replayed, true);
  assert.equal(second.subscriptionId, first.subscriptionId);
  assert.equal(ctx.state.entitlementWrites, 1);
  assert.equal(ctx.state.eventWrites, 1);
});

test("pending/failed/cancelled payment can never activate a subscription", async () => {
  for (const outcome of ["PENDING", "FAILED", "CANCELLED"] as const) {
    const ctx = setup();
    await ctx.initializeGateway(outcome);
    await assert.rejects(() => ctx.service.settle(ctx.input), (e: unknown) =>
      e instanceof MockSettlementError && e.code === "GATEWAY_OUTCOME_NOT_SUCCEEDED"
    );
    assert.equal(ctx.state.payment.status, "PENDING");
    assert.equal(ctx.state.business.current_subscription_id, null);
    assert.equal(ctx.state.activatedSubscriptionId, null);
    assert.equal(ctx.rollbacks, 1);
  }
});

test("UNKNOWN initiation remains blocked", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  ctx.state.payment.initiation_status = "UNKNOWN";
  await assert.rejects(() => ctx.service.settle(ctx.input), (e: unknown) =>
    e instanceof MockSettlementError && e.code === "PAYMENT_INITIATION_CONFLICT"
  );
  assert.equal(ctx.state.payment.status, "PENDING");
});

test("existing subscription blocks replacement", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  ctx.state.business.current_subscription_id = randomUUID();
  await assert.rejects(() => ctx.service.settle(ctx.input), (e: unknown) =>
    e instanceof MockSettlementError && e.code === "EXISTING_SUBSCRIPTION_REQUIRES_REVIEW"
  );
  assert.equal(ctx.state.payment.status, "PENDING");
});

test("database error after marking payment success rolls back every write", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  ctx.setFailure(/^INSERT INTO subscription_events/);
  await assert.rejects(() => ctx.service.settle(ctx.input), /SIMULATED_DATABASE_WRITE_FAILURE/);
  assert.equal(ctx.rollbacks, 1);
  assert.equal(ctx.state.payment.status, "PENDING");
  assert.equal(ctx.state.payment.gateway_transaction_id, null);
  assert.equal(ctx.state.order.status, "PROCESSING");
  assert.equal(ctx.state.activatedSubscriptionId, null);
  assert.equal(ctx.state.entitlementWrites, 0);
  assert.equal(ctx.state.eventWrites, 0);
  assert.equal(ctx.state.business.current_subscription_id, null);
});

test("non-development environment fails before reading the database", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(() => ctx.service.settle(ctx.input), (e: unknown) =>
      e instanceof MockSettlementError && e.code === "MOCK_SETTLEMENT_DISABLED"
    );
  } finally {
    process.env.NODE_ENV = "development";
  }
  assert.equal(ctx.executed.length, 0);
});

test("invalid payment references fail without querying the database", async () => {
  const ctx = setup();
  await assert.rejects(() => ctx.service.settle({
    ...ctx.input, paymentId: "not-a-uuid",
  }), (e: unknown) =>
    e instanceof MockSettlementError && e.code === "INVALID_SETTLEMENT_REFERENCE"
  );
  assert.equal(ctx.executed.length, 0);
});

test("cross-tenant payment references are denied", async () => {
  const ctx = setup();
  await ctx.initializeGateway();
  await assert.rejects(() => ctx.service.settle({
    ...ctx.input, businessId: randomUUID(),
  }), (e: unknown) =>
    e instanceof MockSettlementError && e.code === "PAYMENT_NOT_FOUND"
  );
  assert.equal(ctx.state.payment.status, "PENDING");
});

console.log("INFO: Isolated settlement tests use only injected fake connections; no real DB.");
