import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";

import { MockPaymentGateway } from "../src/modules/payments/gateways/mock-payment.gateway";
import {
  MockPaymentSettlementService,
  MockSettlementError,
} from "../src/modules/payments/payment-settlement.service";

/*
 * DESTRUCTIVE-TEST GUARD.
 * This file inserts test financial records and MUST ONLY run against the
 * freshly-created MySQL 8.4 service container in GitHub Actions.
 * NEVER export these CI flags when working on a local development database.
 */
const allowed =
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.CI === "true" &&
  process.env.RUNNER_OS === "Linux" &&
  process.env.GITHUB_REPOSITORY === "ibainfotech-lk/msme" &&
  process.env.NOTETO_CI_DISPOSABLE_DB === "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
  process.env.NODE_ENV === "development" &&
  process.env.DB_HOST === "127.0.0.1" &&
  process.env.DB_PORT === "3307" &&
  process.env.DB_NAME === "noteto_dev" &&
  process.env.DB_USER === "noteto_services" &&
  process.env.DB_PASSWORD === "ci_dummy_unused_password";

if (!allowed) {
  throw new Error(
    "STOP: MySQL integration tests require an isolated GitHub Actions MySQL 8.4 service."
  );
}

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3307,
  database: "noteto_dev",
  user: "noteto_services",
  password: "ci_dummy_unused_password",
  timezone: "Z",
  decimalNumbers: false,
  connectionLimit: 10,
  waitForConnections: true,
});

after(async () => {
  await pool.end();
});

interface DbRow extends RowDataPacket {
  status: string;
  current_subscription_id?: string | null;
  id?: string;
  activation_payment_id?: string | null;
  gateway_transaction_id?: string | null;
  verified_at?: Date | null;
  n?: number;
  invoice_limit?: number;
  warning_threshold?: number;
}

type Outcome = "SUCCEEDED" | "FAILED" | "CANCELLED" | "PENDING";

function uid(): string {
  return randomUUID();
}

function expectCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MockSettlementError);
    assert.equal(error.code, code);
    return true;
  };
}

async function rows(sql: string, params: unknown[] = []): Promise<DbRow[]> {
  const [result] = await pool.execute<DbRow[]>(sql, params);
  return result;
}

async function initializeDisposableSchema(): Promise<void> {
  const [serverRows] = await pool.query<
    Array<RowDataPacket & { database_name: string; port: number; version: string }>
  >("SELECT DATABASE() AS database_name, @@port AS port, VERSION() AS version");

  assert.equal(serverRows[0]?.database_name, "noteto_dev");
  assert.equal(Number(serverRows[0]?.port), 3306);
  assert.match(serverRows[0]?.version ?? "", /^8\.4\./);

  // Created only by the CI workflow after the migrations have been deployed.
  const [guards] = await pool.query<RowDataPacket[]>(
    "SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"
  );
  assert.equal(guards[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");

  const migrations = await rows(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  assert.equal(Number(migrations[0]?.n), 15);

  const columns = await rows(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'business_subscriptions' AND column_name = 'activation_payment_id'"
  );
  assert.equal(Number(columns[0]?.n), 1);

  console.log("PASSED: Isolated MySQL 8.4 service, disposable guard and 15 migrations verified.");
}

before(async () => {
  await initializeDisposableSchema();
});

interface Fixture {
  businessId: string;
  checkoutOrderId: string;
  paymentId: string;
  planId: string;
  gateway: MockPaymentGateway;
  service: MockPaymentSettlementService;
  gatewayOrderId: string;
  merchantReference: string;
}

async function createFixture(outcome: Outcome = "SUCCEEDED"): Promise<Fixture> {
  const businessId = uid();
  const checkoutOrderId = uid();
  const paymentId = uid();
  const planId = uid();
  const merchantReference = "noteto_" + uid();
  const gateway = new MockPaymentGateway();
  const initiated = await gateway.initiatePayment({
    checkoutOrderId,
    businessId,
    merchantReference,
    amountLkr: "499.00",
    currency: "LKR",
    description: "Ephemeral Noteto CI test",
  });
  if (outcome !== "PENDING") {
    gateway.setTestOutcome(initiated.gatewayOrderId, outcome);
  }

  const connection = await pool.getConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    await connection.execute(
      [
        "INSERT INTO subscription_plans",
        "(id, code, name, price_lkr, billing_interval, invoice_limit,",
        "trial_days, is_active, created_at, updated_at)",
        "VALUES (?, ?, 'CI STANDARD', 499.00, 'MONTHLY', 30, 0, 1,",
        "UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      ].join(" "),
      [planId, "CI_" + uid().replace(/-/g, "")]
    );

    await connection.execute(
      [
        "INSERT INTO businesses",
        "(id, name, registration_type, status, created_at, updated_at)",
        "VALUES (?, 'CI DISPOSABLE BUSINESS', 'SOLE_PROPRIETOR', 'PENDING',",
        "UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      ].join(" "),
      [businessId]
    );

    await connection.execute(
      [
        "INSERT INTO checkout_orders",
        "(id, business_id, plan_id, status, amount_lkr,",
        "idempotency_key, gateway_order_id, expires_at, created_at, updated_at)",
        "VALUES (?, ?, ?, 'PROCESSING', 499.00, ?, ?,",
        "DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE),",
        "UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      ].join(" "),
      [checkoutOrderId, businessId, planId, "checkout_" + uid(), initiated.gatewayOrderId]
    );

    await connection.execute(
      [
        "INSERT INTO platform_payment_transactions",
        "(id, business_id, checkout_order_id, idempotency_key,",
        "gateway, gateway_transaction_id, amount_lkr, status,",
        "initiation_status, merchant_reference, gateway_order_id,",
        "initiation_started_at, initiation_completed_at, created_at, updated_at)",
        "VALUES (?, ?, ?, ?, 'MOCK', NULL, 499.00, 'PENDING',",
        "'INITIATED', ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3),",
        "UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      ].join(" "),
      [
        paymentId, businessId, checkoutOrderId, "payment_" + uid(),
        merchantReference, initiated.gatewayOrderId,
      ]
    );

    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    businessId, checkoutOrderId, paymentId, planId, gateway,
    gatewayOrderId: initiated.gatewayOrderId,
    merchantReference,
    service: new MockPaymentSettlementService(
      gateway, async () => pool.getConnection()
    ),
  };
}

async function verifyUnpaid(fixture: Fixture): Promise<void> {
  const payment = await rows(
    "SELECT status, gateway_transaction_id, verified_at FROM platform_payment_transactions WHERE id = ?",
    [fixture.paymentId]
  );
  const checkout = await rows(
    "SELECT status FROM checkout_orders WHERE id = ?",
    [fixture.checkoutOrderId]
  );
  const business = await rows(
    "SELECT status, current_subscription_id FROM businesses WHERE id = ?",
    [fixture.businessId]
  );
  const subscriptions = await rows(
    "SELECT COUNT(*) AS n FROM business_subscriptions WHERE business_id = ?",
    [fixture.businessId]
  );

  assert.equal(payment[0]?.status, "PENDING");
  assert.equal(payment[0]?.gateway_transaction_id, null);
  assert.equal(payment[0]?.verified_at, null);
  assert.equal(checkout[0]?.status, "PROCESSING");
  assert.equal(business[0]?.status, "PENDING");
  assert.equal(business[0]?.current_subscription_id, null);
  assert.equal(Number(subscriptions[0]?.n), 0);
}

test("real MySQL transaction commits verified payment, checkout, subscription and entitlement once", async () => {
  const f = await createFixture();
  const result = await f.service.settle({
    businessId: f.businessId,
    checkoutOrderId: f.checkoutOrderId,
    paymentId: f.paymentId,
  });

  assert.equal(result.replayed, false);

  const payment = await rows(
    "SELECT status, gateway_transaction_id, verified_at FROM platform_payment_transactions WHERE id = ?",
    [f.paymentId]
  );
  const checkout = await rows("SELECT status FROM checkout_orders WHERE id = ?", [f.checkoutOrderId]);
  const business = await rows(
    "SELECT status, current_subscription_id FROM businesses WHERE id = ?",
    [f.businessId]
  );
  const subscriptions = await rows(
    "SELECT id, status, activation_payment_id FROM business_subscriptions WHERE business_id = ?",
    [f.businessId]
  );
  const entitlements = await rows(
    "SELECT usage_limit AS invoice_limit, warning_threshold FROM subscription_entitlements WHERE subscription_id = ?",
    [result.subscriptionId]
  );
  const events = await rows(
    "SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id = ? AND event_type = 'ACTIVATED'",
    [result.subscriptionId]
  );

  assert.equal(payment[0]?.status, "SUCCEEDED");
  assert.ok(String(payment[0]?.gateway_transaction_id).startsWith("mock_txn_"));
  assert.ok(payment[0]?.verified_at);
  assert.equal(checkout[0]?.status, "PAID");
  assert.equal(business[0]?.status, "ACTIVE");
  assert.equal(business[0]?.current_subscription_id, result.subscriptionId);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].id, result.subscriptionId);
  assert.equal(subscriptions[0].status, "ACTIVE");
  assert.equal(subscriptions[0].activation_payment_id, f.paymentId);
  assert.equal(Number(entitlements[0]?.invoice_limit), 30);
  assert.equal(Number(entitlements[0]?.warning_threshold), 28);
  assert.equal(Number(events[0]?.n), 1);
});

test("replayed settlement after a mock gateway restart adds no duplicate", async () => {
  const f = await createFixture();
  const input = { businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId };
  const first = await f.service.settle(input);

  // The provider is in-memory and intentionally loses state on restart.
  const restarted = new MockPaymentSettlementService(
    new MockPaymentGateway(), async () => pool.getConnection()
  );
  const replayed = await restarted.settle(input);

  assert.equal(replayed.replayed, true);
  assert.equal(replayed.subscriptionId, first.subscriptionId);

  const count = await rows(
    "SELECT COUNT(*) AS n FROM business_subscriptions WHERE activation_payment_id = ?",
    [f.paymentId]
  );
  const events = await rows(
    "SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id = ?",
    [first.subscriptionId]
  );
  assert.equal(Number(count[0]?.n), 1);
  assert.equal(Number(events[0]?.n), 1);
});

test("concurrent duplicate settlement commits one activation only", async () => {
  const f = await createFixture();
  const input = { businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId };
  const results = await Promise.all([f.service.settle(input), f.service.settle(input)]);
  assert.equal(results[0].subscriptionId, results[1].subscriptionId);
  assert.deepEqual(results.map(x => x.replayed).sort(), [false, true]);

  const rows1 = await rows(
    "SELECT COUNT(*) AS n FROM business_subscriptions WHERE business_id = ?",
    [f.businessId]
  );
  const rows2 = await rows(
    "SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id = ?",
    [results[0].subscriptionId]
  );
  assert.equal(Number(rows1[0]?.n), 1);
  assert.equal(Number(rows2[0]?.n), 1);
});

test("failed, pending and cancelled mock payments never activate", async () => {
  for (const outcome of ["PENDING", "FAILED", "CANCELLED"] as const) {
    const f = await createFixture(outcome);
    await assert.rejects(
      () => f.service.settle({
        businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
      }),
      expectCode("GATEWAY_OUTCOME_NOT_SUCCEEDED")
    );
    await verifyUnpaid(f);
  }
});

test("ambiguous UNKNOWN initiation is rejected without payment mutation", async () => {
  const f = await createFixture();
  await pool.execute(
    "UPDATE platform_payment_transactions SET initiation_status = 'UNKNOWN' WHERE id = ?",
    [f.paymentId]
  );
  await assert.rejects(
    () => f.service.settle({
      businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
    }),
    expectCode("PAYMENT_INITIATION_CONFLICT")
  );
  await verifyUnpaid(f);
});

test("real database rollback restores all tables when final business update throws", async () => {
  const f = await createFixture();
  const failBeforeBusinessUpdate = async (): Promise<PoolConnection> => {
    const connection = await pool.getConnection();
    return new Proxy(connection, {
      get(target, property) {
        if (property === "execute") {
          return (sql: string, params?: unknown[]) => {
            if (
              sql.replace(/\s+/g, " ").trim()
                .startsWith("UPDATE businesses SET status = 'ACTIVE'")
            ) {
              throw new Error("CI_SIMULATED_FINAL_WRITE_FAILURE");
            }
            return target.execute(sql, params);
          };
        }
        const method = Reflect.get(target, property, target);
        return typeof method === "function" ? method.bind(target) : method;
      },
    }) as PoolConnection;
  };

  const service = new MockPaymentSettlementService(
    f.gateway, failBeforeBusinessUpdate
  );
  await assert.rejects(
    () => service.settle({
      businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
    }),
    /CI_SIMULATED_FINAL_WRITE_FAILURE/
  );
  await verifyUnpaid(f);

  const events = await rows(
    "SELECT COUNT(*) AS n FROM subscription_events se JOIN business_subscriptions s ON s.id = se.subscription_id WHERE s.business_id = ?",
    [f.businessId]
  );
  assert.equal(Number(events[0]?.n), 0);
});

test("cross-tenant settlement reference is denied", async () => {
  const f = await createFixture();
  await assert.rejects(
    () => f.service.settle({
      businessId: uid(), checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
    }),
    expectCode("PAYMENT_NOT_FOUND")
  );
  await verifyUnpaid(f);
});

test("unique activation-payment index blocks duplicate subscription linkage", async () => {
  const f = await createFixture();
  const first = await f.service.settle({
    businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
  });
  await assert.rejects(async () => {
    await pool.execute(
      [
        "INSERT INTO business_subscriptions",
        "(id, business_id, plan_id, status, activation_payment_id, updated_at)",
        "VALUES (?, ?, ?, 'ACTIVE', ?, UTC_TIMESTAMP(3))",
      ].join(" "),
      [uid(), f.businessId, f.planId, f.paymentId]
    );
  }, (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ER_DUP_ENTRY");
    return true;
  });

  const count = await rows(
    "SELECT COUNT(*) AS n FROM business_subscriptions WHERE activation_payment_id = ?",
    [f.paymentId]
  );
  assert.equal(Number(count[0]?.n), 1);
  assert.ok(first.subscriptionId);
});

test("corrupt subscription pointer blocks verified payment replay", async () => {
  const f = await createFixture();
  await f.service.settle({
    businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
  });
  await pool.execute(
    "UPDATE businesses SET current_subscription_id = NULL WHERE id = ?",
    [f.businessId]
  );
  await assert.rejects(
    () => f.service.settle({
      businessId: f.businessId, checkoutOrderId: f.checkoutOrderId, paymentId: f.paymentId,
    }),
    expectCode("SETTLED_RECORDS_INCONSISTENT")
  );
});

console.log("INFO: Database integration test used isolated GitHub Actions MySQL service.");
