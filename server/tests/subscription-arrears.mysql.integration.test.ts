import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  previewMonthlySubscriptionArrears, previewCurrentHeldSubscriptionArrears, ArrearsPreviewError,
} from "../src/modules/subscriptions/subscription-arrears-preview.service";
import { MonthlyArrearsError } from "../src/modules/subscriptions/subscription-arrears.policy";
import { previewCheckoutRecovery, CheckoutRecoveryPreviewError } from "../src/modules/checkout/checkout-recovery-preview.service";

/* DESTRUCTIVE TEST FIXTURES: ONLY disposable GitHub Actions MySQL 8.4. */
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
if (!allowed) throw new Error("STOP: Disposable GitHub Actions MySQL 8.4 only.");

process.env.NOTETO_ARREARS_PREVIEW_ENABLED = "true";
process.env.NOTETO_ARREARS_HISTORY_READY = "true";
process.env.NOTETO_HOLD_BILLING_STATEMENT_ENABLED = "true";
process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY = "true";
process.env.NOTETO_CHECKOUT_RECOVERY_PREVIEW_ENABLED = "true";

const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, database: "noteto_dev",
  user: "noteto_services", password: "ci_dummy_unused_password",
  timezone: "Z", decimalNumbers: false, connectionLimit: 5,
});

after(async () => { await db.end(); await runtimePool.end(); });

interface Row extends RowDataPacket { n?: number; id?: string; status?: string; token?: string }
async function rows(sql: string, values: unknown[] = []): Promise<Row[]> {
  const [result] = await db.execute<Row[]>(sql, values);
  return result;
}

before(async () => {
  const marker = await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(marker[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const version = await rows("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(version[0]?.version), /^8\.4\./);
  assert.equal(version[0]?.database_name, "noteto_dev");
  const migration = await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
  assert.equal(Number(migration[0]?.n), 25);
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'billing.manage', 'CI') ON DUPLICATE KEY UPDATE `key` = `key`",
    [randomUUID()]
  );
});

const asOf = new Date("2027-02-02T00:00:00.000Z");
const uid = () => randomUUID();

interface Fixture {
  businessId: string;
  userId: string;
  subscriptionId: string;
  checkoutOrderId: string;
  januaryDueId: string;
  februaryDueId: string;
}

async function fixture(includeFebruary = true): Promise<Fixture> {
  const businessId = uid();
  const userId = uid();
  const roleId = uid();
  const planId = uid();
  const checkoutOrderId = uid();
  const subscriptionId = uid();
  const januaryDueId = uid();
  const februaryDueId = uid();

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, "+9477" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")]
    );
    await connection.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI ARREARS', 'SOLE_PROPRIETOR', 'ACTIVE', UTC_TIMESTAMP(3))",
      [businessId]
    );
    await connection.execute(
      "INSERT INTO roles (id, business_id, name, is_system_role, updated_at) VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))",
      [roleId, businessId]
    );
    await connection.execute(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE `key` = 'billing.manage'",
      [roleId]
    );
    await connection.execute(
      "INSERT INTO business_memberships (id, business_id, user_id, role_id, status, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [uid(), businessId, userId, roleId]
    );
    await connection.execute(
      ["INSERT INTO subscription_plans",
       "(id, code, name, price_lkr, billing_interval, trial_days, invoice_limit, is_active, updated_at)",
       "VALUES (?, ?, 'CI MONTHLY', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))"].join(" "),
      [planId, "CI_AR_" + uid().replace(/-/g, "").toUpperCase()]
    );
    await connection.execute(
      ["INSERT INTO checkout_orders",
       "(id, business_id, plan_id, status, amount_lkr, idempotency_key, expires_at, updated_at)",
       "VALUES (?, ?, ?, 'PAID', 499.00, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))"].join(" "),
      [checkoutOrderId, businessId, planId, "ci_ar_order_" + uid()]
    );
    await connection.execute(
      ["INSERT INTO business_subscriptions",
       "(id, business_id, plan_id, status, starts_at, updated_at)",
       "VALUES (?, ?, ?, 'ACTIVE', '2026-12-31 18:30:00.000', UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId, businessId, planId]
    );
    await connection.execute(
      ["INSERT INTO subscription_monthly_dues",
       "(id, business_id, subscription_id, billing_month, due_at, charge_lkr, waived_lkr, status)",
       "VALUES (?, ?, ?, '2027-01-01', '2026-12-31 18:30:00.000', 499.00, 0.00, 'OPEN')"].join(" "),
      [januaryDueId, businessId, subscriptionId]
    );
    if (includeFebruary) {
      await connection.execute(
        ["INSERT INTO subscription_monthly_dues",
         "(id, business_id, subscription_id, billing_month, due_at, charge_lkr, waived_lkr, status)",
         "VALUES (?, ?, ?, '2027-02-01', '2027-01-31 18:30:00.000', 499.00, 0.00, 'OPEN')"].join(" "),
        [februaryDueId, businessId, subscriptionId]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { businessId, userId, subscriptionId, checkoutOrderId, januaryDueId, februaryDueId };
}

function preview(f: Fixture) {
  return previewMonthlySubscriptionArrears({
    businessId: f.businessId, subscriptionId: f.subscriptionId, userId: f.userId,
    asOf,
  });
}

test("two unpaid months quote LKR 998 without charging or activating anything", async () => {
  const f = await fixture();
  const quote = await preview(f);
  assert.equal(quote.totalOutstandingLkr, "998.00");
  assert.equal(quote.penaltyLkr, "0.00");
  assert.equal(quote.paymentActionAllowed, false);
  const paymentCount = await rows("SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id = ?", [f.businessId]);
  assert.equal(Number(paymentCount[0]?.n), 0);
});

test("verified partial allocation reduces outstanding but no other month", async () => {
  const f = await fixture();
  const paymentId = uid();
  await db.execute(
    ["INSERT INTO platform_payment_transactions",
     "(id, business_id, checkout_order_id, idempotency_key, gateway, amount_lkr, status,",
     "initiation_status, verified_at, updated_at)",
     "VALUES (?, ?, ?, ?, 'CI_MOCK', 200.00, 'SUCCEEDED', 'INITIATED', '2027-01-10 00:00:00.000', UTC_TIMESTAMP(3))"].join(" "),
    [paymentId, f.businessId, f.checkoutOrderId, "ci_ar_payment_" + uid()]
  );
  await db.execute(
    ["INSERT INTO subscription_due_allocations",
     "(id, business_id, monthly_due_id, payment_id, amount_lkr)",
     "VALUES (?, ?, ?, ?, 200.00)"].join(" "),
    [uid(), f.businessId, f.januaryDueId, paymentId]
  );
  const quote = await preview(f);
  assert.equal(quote.totalOutstandingLkr, "798.00");
  assert.equal(quote.lines[0].verifiedPaidLkr, "200.00");
});

test("waived first month is not collected from the customer", async () => {
  const f = await fixture();
  await db.execute(
    "UPDATE subscription_monthly_dues SET status = 'WAIVED', waived_lkr = 499.00 WHERE id = ?",
    [f.januaryDueId]
  );
  const quote = await preview(f);
  assert.equal(quote.totalOutstandingLkr, "499.00");
  assert.equal(quote.lines[0].outstandingLkr, "0.00");
});

test("tenant foreign keys reject allocations tied to another business payment", async () => {
  const a = await fixture();
  const b = await fixture();
  const paymentId = uid();
  await db.execute(
    ["INSERT INTO platform_payment_transactions",
     "(id, business_id, checkout_order_id, idempotency_key, gateway, amount_lkr, status, initiation_status, verified_at, updated_at)",
     "VALUES (?, ?, ?, ?, 'CI_MOCK', 100.00, 'SUCCEEDED', 'INITIATED', '2027-01-10 00:00:00.000', UTC_TIMESTAMP(3))"].join(" "),
    [paymentId, b.businessId, b.checkoutOrderId, "ci_ar_other_" + uid()]
  );
  await assert.rejects(() => db.execute(
    ["INSERT INTO subscription_due_allocations",
     "(id, business_id, monthly_due_id, payment_id, amount_lkr)",
     "VALUES (?, ?, ?, ?, 100.00)"].join(" "),
    [uid(), a.businessId, a.januaryDueId, paymentId]
  ));
  const count = await rows("SELECT COUNT(*) AS n FROM subscription_due_allocations WHERE monthly_due_id = ?", [a.januaryDueId]);
  assert.equal(Number(count[0]?.n), 0);
});

test("missing monthly history is rejected rather than silently under-billed", async () => {
  const f = await fixture(false);
  await assert.rejects(
    () => preview(f),
    (error: unknown) => {
      assert.ok(error instanceof MonthlyArrearsError);
      assert.equal(error.code, "BILLING_HISTORY_INCOMPLETE");
      return true;
    }
  );
});

test("unique monthly due constraint prevents duplicate January charges", async () => {
  const f = await fixture();
  await assert.rejects(() => db.execute(
    ["INSERT INTO subscription_monthly_dues",
     "(id, business_id, subscription_id, billing_month, due_at, charge_lkr)",
     "VALUES (?, ?, ?, '2027-01-01', '2026-12-31 18:30:00.000', 499.00)"].join(" "),
    [uid(), f.businessId, f.subscriptionId]
  ));
  const count = await rows("SELECT COUNT(*) AS n FROM subscription_monthly_dues WHERE subscription_id = ?", [f.subscriptionId]);
  assert.equal(Number(count[0]?.n), 2);
});

test("production runtime disables billing preview before opening DB", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => previewMonthlySubscriptionArrears({
        businessId: f.businessId, userId: f.userId, subscriptionId: f.subscriptionId, asOf,
      }, async () => { throw Error("UNEXPECTED_DB_CONNECTION"); }),
      (error: unknown) => {
        assert.ok(error instanceof ArrearsPreviewError);
        assert.equal(error.code, "ARREARS_PREVIEW_DISABLED");
        return true;
      }
    );
  } finally { process.env.NODE_ENV = "development"; }
});

test("incomplete history flag disables preview before opening DB", async () => {
  const f = await fixture();
  try {
    process.env.NOTETO_ARREARS_HISTORY_READY = "false";
    await assert.rejects(
      () => previewMonthlySubscriptionArrears({
        businessId: f.businessId, userId: f.userId, subscriptionId: f.subscriptionId, asOf,
      }, async () => { throw Error("UNEXPECTED_DB_CONNECTION"); }),
      (error: unknown) => {
        assert.ok(error instanceof ArrearsPreviewError);
        assert.equal(error.code, "ARREARS_HISTORY_NOT_READY");
        return true;
      }
    );
  } finally { process.env.NOTETO_ARREARS_HISTORY_READY = "true"; }
});
test("read-only recovery inspects paid order without another gateway operation", async () => {
  const f = await fixture();
  const quote = await previewCheckoutRecovery({
    businessId: f.businessId, userId: f.userId, checkoutOrderId: f.checkoutOrderId,
  });
  assert.equal(quote.action, "VERIFY_SETTLEMENT");
  assert.equal(quote.paymentActionAllowed, false);
  assert.equal(quote.recordedPaymentAttempts, 0);
});

test("unpaid pending order may be resumed, but this preview never initiates payment", async () => {
  const f = await fixture();
  await db.execute(
    "UPDATE checkout_orders SET status = 'PENDING', expires_at = '2030-01-01 00:00:00.000' WHERE id = ?",
    [f.checkoutOrderId]
  );
  const quote = await previewCheckoutRecovery({
    businessId: f.businessId, userId: f.userId, checkoutOrderId: f.checkoutOrderId,
  });
  assert.equal(quote.action, "RESUME_UNPAID_CHECKOUT");
  assert.equal(quote.paymentActionAllowed, false);
  const attempts = await rows(
    "SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE checkout_order_id = ?",
    [f.checkoutOrderId]
  );
  assert.equal(Number(attempts[0]?.n), 0);
});

test("unknown initiation blocks duplicate recovery even with pending order", async () => {
  const f = await fixture();
  await db.execute(
    "UPDATE checkout_orders SET status = 'PENDING', expires_at = '2030-01-01 00:00:00.000' WHERE id = ?",
    [f.checkoutOrderId]
  );
  await db.execute(
    ["INSERT INTO platform_payment_transactions",
     "(id, business_id, checkout_order_id, idempotency_key, gateway, amount_lkr, status, initiation_status, updated_at)",
     "VALUES (?, ?, ?, ?, 'CI_MOCK', 499.00, 'PENDING', 'UNKNOWN', UTC_TIMESTAMP(3))"].join(" "),
    [uid(), f.businessId, f.checkoutOrderId, "ci_ar_unknown_" + uid()]
  );
  const quote = await previewCheckoutRecovery({
    businessId: f.businessId, userId: f.userId, checkoutOrderId: f.checkoutOrderId,
  });
  assert.equal(quote.action, "RECONCILIATION_REQUIRED");
  assert.equal(quote.recordedPaymentAttempts, 1);
  assert.equal(quote.paymentActionAllowed, false);
});

test("production guard rejects checkout inspection before DB connection", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => previewCheckoutRecovery({
        businessId: f.businessId, userId: f.userId, checkoutOrderId: f.checkoutOrderId,
      }, async () => { throw Error("UNEXPECTED_CONNECTION"); }),
      (error: unknown) => {
        assert.ok(error instanceof CheckoutRecoveryPreviewError);
        assert.equal(error.code, "CHECKOUT_RECOVERY_PREVIEW_DISABLED");
        return true;
      }
    );
  } finally { process.env.NODE_ENV = "development"; }
});

console.log("INFO: Monthly arrears and checkout recovery previews are read-only; disposable CI MySQL only.");

async function markHeld(f: Fixture, heldAt: string | null = "2027-01-05 00:00:00.000") {
  await db.execute("UPDATE business_subscriptions SET status = 'PAST_DUE', held_at = ? WHERE id = ? AND business_id = ?",
    [heldAt, f.subscriptionId, f.businessId]);
  await db.execute("UPDATE businesses SET current_subscription_id = ? WHERE id = ?",
    [f.subscriptionId, f.businessId]);
}
const heldStatement = (f: Fixture) => previewCurrentHeldSubscriptionArrears({
  businessId: f.businessId, userId: f.userId, asOf,
});

test("held statement shows Jan and Feb LKR 998 with no payment created", async () => {
  const f = await fixture();
  await markHeld(f);
  const q = await heldStatement(f);
  assert.equal(q.totalOutstandingLkr, "998.00");
  assert.deepEqual(q.lines.map(x => x.outstandingLkr), ["499.00", "499.00"]);
  assert.equal(q.penaltyLkr, "0.00");
  assert.equal(q.paymentActionAllowed, false);
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id = ?", [f.businessId]
  ))[0]?.n), 0);
});
test("held statement excludes waived introductory month", async () => {
  const f = await fixture();
  await markHeld(f);
  await db.execute("UPDATE subscription_monthly_dues SET status='WAIVED', waived_lkr=499.00 WHERE id=?",
    [f.januaryDueId]);
  const q = await heldStatement(f);
  assert.equal(q.totalOutstandingLkr, "499.00");
  assert.equal(q.lines[0].outstandingLkr, "0.00");
});
test("hold statement refuses unreviewed or absent hold timestamp", async () => {
  const f = await fixture();
  await markHeld(f, null);
  await assert.rejects(() => heldStatement(f), (e: unknown) => {
    assert.ok(e instanceof ArrearsPreviewError);
    assert.equal(e.code, "REVIEWED_HOLD_REQUIRED");
    return true;
  });
});
test("hold statement cannot be requested for active subscriptions", async () => {
  const f = await fixture();
  await db.execute("UPDATE businesses SET current_subscription_id = ? WHERE id = ?",
    [f.subscriptionId, f.businessId]);
  await assert.rejects(() => heldStatement(f), (e: unknown) => {
    assert.ok(e instanceof ArrearsPreviewError);
    assert.equal(e.code, "REVIEWED_HOLD_REQUIRED");
    return true;
  });
});
test("missing February ledger prevents presenting a misleading partial balance", async () => {
  const f = await fixture(false);
  await markHeld(f);
  await assert.rejects(() => heldStatement(f), (e: unknown) => {
    assert.ok(e instanceof MonthlyArrearsError);
    assert.equal(e.code, "BILLING_HISTORY_INCOMPLETE");
    return true;
  });
});
test("another tenant cannot access held subscription statement", async () => {
  const a = await fixture(), b = await fixture();
  await markHeld(a);
  await assert.rejects(
    () => previewCurrentHeldSubscriptionArrears({
      businessId: a.businessId, userId: b.userId, asOf,
    }),
    (e: unknown) => {
      assert.ok(e instanceof ArrearsPreviewError);
      assert.equal(e.code, "BILLING_PERMISSION_DENIED");
      return true;
    });
});
test("verified payment history flag blocks statement before opening DB", async () => {
  const f = await fixture();
  try {
    process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY = "false";
    await assert.rejects(() => previewCurrentHeldSubscriptionArrears({
      businessId: f.businessId, userId: f.userId, asOf,
    }, async () => { throw Error("UNEXPECTED_DB"); }), (e: unknown) => {
      assert.ok(e instanceof ArrearsPreviewError);
      assert.equal(e.code, "HOLD_BILLING_STATEMENT_NOT_READY");
      return true;
    });
  } finally {
    process.env.NOTETO_VERIFIED_PAYMENT_HISTORY_READY = "true";
  }
});

test("held billing cannot count payment lacking settled checkout and gateway evidence", async () => {
  const f = await fixture();
  await markHeld(f);
  const paymentId = uid();
  await db.execute(
    ["INSERT INTO platform_payment_transactions",
     "(id, business_id, checkout_order_id, idempotency_key, gateway, amount_lkr, status,",
     "initiation_status, verified_at, updated_at)",
     "VALUES (?, ?, ?, ?, 'CI_MOCK', 200.00, 'SUCCEEDED', 'INITIATED', '2027-01-10 00:00:00.000', UTC_TIMESTAMP(3))"].join(" "),
    [paymentId, f.businessId, f.checkoutOrderId, "ci_held_missing_gateway_" + uid()]
  );
  await db.execute(
    ["INSERT INTO subscription_due_allocations",
     "(id, business_id, monthly_due_id, payment_id, amount_lkr)",
     "VALUES (?, ?, ?, ?, 200.00)"].join(" "),
    [uid(), f.businessId, f.januaryDueId, paymentId]
  );
  await assert.rejects(() => heldStatement(f), (e: unknown) => {
    assert.ok(e instanceof ArrearsPreviewError);
    assert.equal(e.code, "PAYMENT_ALLOCATION_RECONCILIATION_REQUIRED");
    return true;
  });
});
