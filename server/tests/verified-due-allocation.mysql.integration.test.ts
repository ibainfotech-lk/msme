import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  allocateVerifiedMonthlyPayment,
  VerifiedDueAllocationError,
  type AllocateVerifiedDuePaymentInput,
} from "../src/modules/subscriptions/verified-due-allocation.service";

/* NEVER run this fixture outside the disposable CI MySQL 8.4 service. */
const allowed =
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_OS === "Linux" &&
  process.env.GITHUB_REPOSITORY === "ibainfotech-lk/msme" &&
  process.env.NODE_ENV === "development" &&
  process.env.NOTETO_CI_DISPOSABLE_DB === "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
  process.env.DB_HOST === "127.0.0.1" &&
  process.env.DB_PORT === "3307" &&
  process.env.DB_NAME === "noteto_dev" &&
  process.env.DB_USER === "noteto_services" &&
  process.env.DB_PASSWORD === "ci_dummy_unused_password";
if (!allowed) throw new Error("STOP: Only disposable GitHub Actions MySQL 8.4 can run allocation tests.");

process.env.NOTETO_DUE_ALLOCATION_ENABLED = "true";
process.env.NOTETO_ARREARS_HISTORY_READY = "true";
process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY = "true";

const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, database: "noteto_dev",
  user: "noteto_services", password: "ci_dummy_unused_password",
  timezone: "Z", decimalNumbers: false, connectionLimit: 8,
});
after(async () => { await db.end(); await runtimePool.end(); });

interface Row extends RowDataPacket { n?: number; status?: string; amount_lkr?: string; token?: string }
async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await db.execute<Row[]>(sql, params);
  return result;
}
const uid = () => randomUUID();
const phone = () => "+9477" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");

before(async () => {
  const marker = await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(marker[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const server = await rows("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(server[0]?.version), /^8\.4\./);
  assert.equal(server[0]?.database_name, "noteto_dev");
  const migrations = await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
  assert.equal(Number(migrations[0]?.n), 17);
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'billing.manage', 'CI') ON DUPLICATE KEY UPDATE `key` = `key`",
    [uid()]
  );
});

interface Fixture {
  businessId: string;
  userId: string;
  subscriptionId: string;
  checkoutOrderId: string;
  monthlyDueId: string;
  paymentId: string;
}
async function fixture(paymentAmount = "499.00", paymentStatus: "SUCCEEDED" | "PENDING" | "FAILED" | "REFUNDED" = "SUCCEEDED"): Promise<Fixture> {
  const businessId = uid(), userId = uid(), subscriptionId = uid();
  const roleId = uid(), planId = uid(), checkoutOrderId = uid();
  const monthlyDueId = uid(), paymentId = uid();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, phone()]
    );
    await conn.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI MONTHLY', 'SOLE_PROPRIETOR', 'ACTIVE', UTC_TIMESTAMP(3))",
      [businessId]
    );
    await conn.execute(
      "INSERT INTO roles (id, business_id, name, is_system_role, updated_at) VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))",
      [roleId, businessId]
    );
    await conn.execute(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE `key` = 'billing.manage'",
      [roleId]
    );
    await conn.execute(
      "INSERT INTO business_memberships (id, business_id, user_id, role_id, status, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [uid(), businessId, userId, roleId]
    );
    await conn.execute(
      ["INSERT INTO subscription_plans",
       "(id, code, name, price_lkr, billing_interval, trial_days, invoice_limit, is_active, updated_at)",
       "VALUES (?, ?, 'CI MONTHLY', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))"].join(" "),
      [planId, "CI_PA_" + uid().replace(/-/g, "").toUpperCase()]
    );
    await conn.execute(
      ["INSERT INTO checkout_orders",
       "(id, business_id, plan_id, status, amount_lkr, idempotency_key, expires_at, updated_at)",
       "VALUES (?, ?, ?, 'PAID', 499.00, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))"].join(" "),
      [checkoutOrderId, businessId, planId, "ci_pa_order_" + uid()]
    );
    await conn.execute(
      ["INSERT INTO business_subscriptions",
       "(id, business_id, plan_id, status, starts_at, updated_at)",
       "VALUES (?, ?, ?, 'ACTIVE', '2026-09-01 00:00:00.000', UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId, businessId, planId]
    );
    await conn.execute(
      ["INSERT INTO subscription_monthly_dues",
       "(id, business_id, subscription_id, billing_month, due_at, charge_lkr, waived_lkr, status)",
       "VALUES (?, ?, ?, '2026-10-01', '2026-10-01 00:00:00.000', 499.00, 0.00, 'OPEN')"].join(" "),
      [monthlyDueId, businessId, subscriptionId]
    );
    await conn.execute(
      ["INSERT INTO platform_payment_transactions",
       "(id, business_id, checkout_order_id, idempotency_key, gateway,",
       "gateway_transaction_id, amount_lkr, status, initiation_status, verified_at, updated_at)",
       "VALUES (?, ?, ?, ?, 'CI_MOCK', ?, ?, ?, 'INITIATED', DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE), UTC_TIMESTAMP(3))"].join(" "),
      [paymentId, businessId, checkoutOrderId, "ci_pa_payment_" + uid(),
       "ci_tx_" + uid(), paymentAmount, paymentStatus]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
  return { businessId, userId, subscriptionId, checkoutOrderId, monthlyDueId, paymentId };
}
function input(f: Fixture, amountLkr = "499.00"): AllocateVerifiedDuePaymentInput {
  return {
    businessId: f.businessId, subscriptionId: f.subscriptionId,
    monthlyDueId: f.monthlyDueId, paymentId: f.paymentId,
    userId: f.userId, amountLkr,
  };
}
function code(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof VerifiedDueAllocationError);
    assert.equal(error.code, expected);
    return true;
  };
}

test("a single verified 499 payment settles a 499 due; exact replay is read-only", async () => {
  const f = await fixture();
  const first = await allocateVerifiedMonthlyPayment(input(f));
  assert.equal(first.dueStatus, "SETTLED");
  assert.equal(first.dueOutstandingLkr, "0.00");
  assert.equal(first.replayed, false);
  assert.equal(first.paymentInitiated, false);
  const replay = await allocateVerifiedMonthlyPayment(input(f));
  assert.equal(replay.replayed, true);
  assert.equal(replay.allocationId, first.allocationId);
  const count = await rows("SELECT COUNT(*) AS n FROM subscription_due_allocations WHERE monthly_due_id = ?", [f.monthlyDueId]);
  assert.equal(Number(count[0]?.n), 1);
  const due = await rows("SELECT status FROM subscription_monthly_dues WHERE id = ?", [f.monthlyDueId]);
  assert.equal(due[0]?.status, "SETTLED");
  const payments = await rows("SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id = ?", [f.businessId]);
  assert.equal(Number(payments[0]?.n), 1);
});

test("verified 200 partial payment leaves LKR 299 outstanding", async () => {
  const f = await fixture("200.00");
  const first = await allocateVerifiedMonthlyPayment(input(f, "200.00"));
  assert.equal(first.dueStatus, "OPEN");
  assert.equal(first.dueOutstandingLkr, "299.00");
  const reply = await allocateVerifiedMonthlyPayment(input(f, "200.00"));
  assert.equal(reply.replayed, true);
  assert.equal(reply.dueOutstandingLkr, "299.00");
  await assert.rejects(() => allocateVerifiedMonthlyPayment(input(f, "199.00")),
    code("ALLOCATION_IDEMPOTENCY_CONFLICT"));
});

test("a verified payment cannot overallocate beyond either due or payment total", async () => {
  const f = await fixture("200.00");
  await assert.rejects(() => allocateVerifiedMonthlyPayment(input(f, "300.00")),
    code("ALLOCATION_EXCEEDS_VERIFIED_FUNDS"));
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM subscription_due_allocations WHERE business_id = ?", [f.businessId]
  ))[0]?.n), 0);
});

test("one verified payment cannot be spent twice across two different months", async () => {
  const f = await fixture();
  const novemberDueId = uid();
  await db.execute(
    ["INSERT INTO subscription_monthly_dues",
     "(id, business_id, subscription_id, billing_month, due_at, charge_lkr, waived_lkr, status)",
     "VALUES (?, ?, ?, '2026-11-01', '2026-11-01 00:00:00.000', 499.00, 0.00, 'OPEN')"].join(" "),
    [novemberDueId, f.businessId, f.subscriptionId]
  );
  const october = await allocateVerifiedMonthlyPayment(input(f, "300.00"));
  assert.equal(october.dueOutstandingLkr, "199.00");
  await assert.rejects(() => allocateVerifiedMonthlyPayment({
    ...input(f, "200.00"), monthlyDueId: novemberDueId,
  }), code("ALLOCATION_EXCEEDS_VERIFIED_FUNDS"));
  const november = await allocateVerifiedMonthlyPayment({
    ...input(f, "199.00"), monthlyDueId: novemberDueId,
  });
  assert.equal(november.dueOutstandingLkr, "300.00");
  const total = await rows(
    "SELECT COALESCE(SUM(amount_lkr), 0.00) AS amount_lkr FROM subscription_due_allocations WHERE business_id = ? AND payment_id = ?",
    [f.businessId, f.paymentId]
  );
  assert.equal(String(total[0]?.amount_lkr), "499.00");
});

test("a payment with unsettled checkout cannot be allocated", async () => {
  const f = await fixture();
  await db.execute(
    "UPDATE checkout_orders SET status = 'PENDING' WHERE id = ?",
    [f.checkoutOrderId]
  );
  await assert.rejects(() => allocateVerifiedMonthlyPayment(input(f)),
    code("PAYMENT_VERIFICATION_REQUIRED"));
});

test("rejected payment statuses never count as verified allocations", async () => {
  for (const status of ["PENDING", "FAILED", "REFUNDED"] as const) {
    const f = await fixture("499.00", status);
    await assert.rejects(() => allocateVerifiedMonthlyPayment(input(f)),
      code("PAYMENT_VERIFICATION_REQUIRED"));
  }
});

test("cross-business payment cannot settle another business due", async () => {
  const a = await fixture();
  const b = await fixture();
  await assert.rejects(() => allocateVerifiedMonthlyPayment({
    ...input(a), paymentId: b.paymentId,
  }), code("PAYMENT_VERIFICATION_REQUIRED"));
});

test("waived months and not-yet-due months cannot be allocated", async () => {
  const waived = await fixture();
  await db.execute(
    "UPDATE subscription_monthly_dues SET status = 'WAIVED', waived_lkr = 499.00 WHERE id = ?",
    [waived.monthlyDueId]
  );
  await assert.rejects(() => allocateVerifiedMonthlyPayment(input(waived)),
    code("DUE_NOT_ELIGIBLE"));

  const future = await fixture();
  await db.execute(
    "UPDATE subscription_monthly_dues SET due_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 MONTH) WHERE id = ?",
    [future.monthlyDueId]
  );
  await assert.rejects(() => allocateVerifiedMonthlyPayment(input(future)),
    code("DUE_NOT_ELIGIBLE"));
});

test("same allocation requested concurrently creates only one allocation row", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    allocateVerifiedMonthlyPayment(input(f)), allocateVerifiedMonthlyPayment(input(f)),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  const values = results.filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof allocateVerifiedMonthlyPayment>>>).value);
  assert.equal(values.filter(v => v.replayed === true).length, 1);
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM subscription_due_allocations WHERE monthly_due_id = ?", [f.monthlyDueId]
  ))[0]?.n), 1);
});

test("production and history guards reject before opening a connection", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => allocateVerifiedMonthlyPayment(input(f), async () => { throw Error("DB_CALLED"); }),
      code("DUE_ALLOCATION_DISABLED")
    );
  } finally { process.env.NODE_ENV = "development"; }
  try {
    process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY = "false";
    await assert.rejects(
      () => allocateVerifiedMonthlyPayment(input(f), async () => { throw Error("DB_CALLED"); }),
      code("PAYMENT_OR_BILLING_HISTORY_NOT_READY")
    );
  } finally { process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY = "true"; }
});

console.log("INFO: Verified due allocation CI fixtures are disposable only; no live gateway calls.");
