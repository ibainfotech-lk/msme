import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  reserveIntroductoryTrial, TrialReservationError,
} from "../src/modules/subscriptions/trial-grant-reservation.service";

/* Destructive fixture tests. NEVER run with local or production MySQL. */
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
if (!allowed) throw new Error("STOP: Trial tests require disposable GitHub Actions MySQL 8.4.");
// Simulates a reviewed history backfill ONLY in the disposable CI database.
process.env.NOTETO_TRIAL_IDENTITY_HISTORY_READY = "true";
process.env.NOTETO_TRIAL_RESERVATIONS_ENABLED = "true";

const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, database: "noteto_dev",
  user: "noteto_services", password: "ci_dummy_unused_password",
  timezone: "Z", decimalNumbers: false, connectionLimit: 5,
});
after(async () => { await db.end(); await runtimePool.end(); });

interface Row extends RowDataPacket { n?: number; status?: string; current_subscription_id?: string | null; token?: string }
async function query(sql: string, values: unknown[] = []): Promise<Row[]> {
  const [rows] = await db.execute<Row[]>(sql, values);
  return rows;
}

before(async () => {
  const guard = await query("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guard[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const version = await query("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(version[0]?.version), /^8\.4\./);
  assert.equal(version[0]?.database_name, "noteto_dev");
  const migration = await query("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
  assert.equal(Number(migration[0]?.n), 24);
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'billing.manage', 'CI') ON DUPLICATE KEY UPDATE `key` = `key`",
    [randomUUID()]
  );
});

function expectCode(code: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof TrialReservationError);
    assert.equal(err.code, code);
    return true;
  };
}

interface Fixture { businessId: string; userId: string; orderId: string; fingerprint: string }
async function fixture(options: {
  verified?: boolean; fingerprint?: string; withPayment?: boolean;
} = {}): Promise<Fixture> {
  const businessId = randomUUID();
  const userId = randomUUID();
  const orderId = randomUUID();
  const roleId = randomUUID();
  const planId = randomUUID();
  const fingerprint = options.fingerprint ?? randomBytes(32).toString("hex");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, "+9477" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")]
    );
    await connection.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI TEST', 'SOLE_PROPRIETOR', 'PENDING', UTC_TIMESTAMP(3))",
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
      [randomUUID(), businessId, userId, roleId]
    );
    await connection.execute(
      ["INSERT INTO subscription_plans",
       "(id, code, name, price_lkr, billing_interval, trial_days, invoice_limit, is_active, updated_at)",
       "VALUES (?, ?, 'CI STANDARD', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))"].join(" "),
      [planId, "CI_" + randomUUID().replace(/-/g, "")]
    );
    await connection.execute(
      ["INSERT INTO checkout_orders",
       "(id, business_id, plan_id, status, amount_lkr, idempotency_key, expires_at, updated_at)",
       "VALUES (?, ?, ?, 'PENDING', 499.00, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE), UTC_TIMESTAMP(3))"].join(" "),
      [orderId, businessId, planId, "ci_trial_" + randomUUID()]
    );
    if (options.verified) {
      await connection.execute(
        ["INSERT INTO verified_business_identities",
         "(id, business_id, identity_fingerprint, verification_method, evidence_reference_sha256, verified_at)",
         "VALUES (?, ?, ?, 'CI_TEST_ONLY', ?, UTC_TIMESTAMP(3))"].join(" "),
        [randomUUID(), businessId, fingerprint, randomBytes(32).toString("hex")]
      );
    }
    if (options.withPayment) {
      await connection.execute(
        ["INSERT INTO platform_payment_transactions",
         "(id, business_id, checkout_order_id, idempotency_key, gateway,",
         "amount_lkr, status, initiation_status, updated_at)",
         "VALUES (?, ?, ?, ?, 'MOCK', 499.00, 'PENDING', 'RESERVED', UTC_TIMESTAMP(3))"].join(" "),
        [randomUUID(), businessId, orderId, "ci_pay_" + randomUUID()]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return { businessId, userId, orderId, fingerprint };
}

function input(f: Fixture) {
  return { businessId: f.businessId, userId: f.userId, checkoutOrderId: f.orderId };
}

test("unverified business cannot reserve or cancel checkout", async () => {
  const f = await fixture();
  await assert.rejects(() => reserveIntroductoryTrial(input(f)), expectCode("BUSINESS_IDENTITY_NOT_VERIFIED"));
  const orders = await query("SELECT status FROM checkout_orders WHERE id = ?", [f.orderId]);
  assert.equal(orders[0].status, "PENDING");
  const grants = await query("SELECT COUNT(*) AS n FROM introductory_trial_grants WHERE business_id = ?", [f.businessId]);
  assert.equal(Number(grants[0]?.n), 0);
});

test("verified reservation cancels unpaid order but never activates subscription", async () => {
  const f = await fixture({ verified: true });
  const reserved = await reserveIntroductoryTrial(input(f));
  assert.equal(reserved.status, "RESERVED");
  assert.equal(reserved.replayed, false);
  const replay = await reserveIntroductoryTrial(input(f));
  assert.equal(replay.grantId, reserved.grantId);
  assert.equal(replay.replayed, true);
  const order = await query("SELECT status FROM checkout_orders WHERE id = ?", [f.orderId]);
  const business = await query("SELECT status, current_subscription_id FROM businesses WHERE id = ?", [f.businessId]);
  const subs = await query("SELECT COUNT(*) AS n FROM business_subscriptions WHERE business_id = ?", [f.businessId]);
  const payments = await query("SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id = ?", [f.businessId]);
  assert.equal(order[0].status, "CANCELLED");
  assert.equal(business[0].status, "PENDING");
  assert.equal(business[0].current_subscription_id, null);
  assert.equal(Number(subs[0]?.n), 0);
  assert.equal(Number(payments[0]?.n), 0);
  const claims = await query("SELECT COUNT(*) AS n FROM identity_offer_claims WHERE identity_fingerprint = ?", [f.fingerprint]);
  assert.equal(Number(claims[0]?.n), 1);
});

test("same verified identity cannot reserve twice across different businesses", async () => {
  const fingerprint = randomBytes(32).toString("hex");
  const first = await fixture({ verified: true, fingerprint });
  const second = await fixture({ verified: true, fingerprint });
  await reserveIntroductoryTrial(input(first));
  await assert.rejects(() => reserveIntroductoryTrial(input(second)), expectCode("TRIAL_ALREADY_GRANTED"));
  const grants = await query("SELECT COUNT(*) AS n FROM introductory_trial_grants WHERE identity_fingerprint = ?", [fingerprint]);
  assert.equal(Number(grants[0]?.n), 1);
});

test("any payment attempt blocks reservation and leaves checkout untouched", async () => {
  const f = await fixture({ verified: true, withPayment: true });
  await assert.rejects(() => reserveIntroductoryTrial(input(f)), expectCode("PAYMENT_RECONCILIATION_REQUIRED"));
  const order = await query("SELECT status FROM checkout_orders WHERE id = ?", [f.orderId]);
  assert.equal(order[0].status, "PENDING");
});

test("production environment fails before opening a connection", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => reserveIntroductoryTrial(input(f), async () => { throw new Error("UNEXPECTED_CONNECTION"); }),
      expectCode("TRIAL_RESERVATION_DISABLED")
    );
  } finally { process.env.NODE_ENV = "development"; }
});

test("history readiness is required before any DB connection", async () => {
  const f = await fixture();
  try {
    process.env.NOTETO_TRIAL_IDENTITY_HISTORY_READY = "false";
    await assert.rejects(
      () => reserveIntroductoryTrial(input(f), async () => { throw new Error("UNEXPECTED_CONNECTION"); }),
      expectCode("IDENTITY_HISTORY_NOT_READY")
    );
  } finally { process.env.NOTETO_TRIAL_IDENTITY_HISTORY_READY = "true"; }
});

test("concurrent reservations for the same identity never double-grant", async () => {
  const fingerprint = randomBytes(32).toString("hex");
  const a = await fixture({ verified: true, fingerprint });
  const b = await fixture({ verified: true, fingerprint });
  const outcomes = await Promise.allSettled([
    reserveIntroductoryTrial(input(a)), reserveIntroductoryTrial(input(b)),
  ]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
  const grants = await query(
    "SELECT COUNT(*) AS n FROM introductory_trial_grants WHERE identity_fingerprint = ?",
    [fingerprint]
  );
  assert.equal(Number(grants[0]?.n), 1);
});

test("reservations-disabled flag stops before any DB connection", async () => {
  const f = await fixture();
  try {
    process.env.NOTETO_TRIAL_RESERVATIONS_ENABLED = "false";
    await assert.rejects(
      () => reserveIntroductoryTrial(input(f), async () => { throw new Error("UNEXPECTED_CONNECTION"); }),
      expectCode("TRIAL_RESERVATION_DISABLED")
    );
  } finally { process.env.NOTETO_TRIAL_RESERVATIONS_ENABLED = "true"; }
});
