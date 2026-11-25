import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  reservePromotion, PromotionReservationError,
} from "../src/modules/subscriptions/promotion-reservation.service";
import {
  reserveIntroductoryTrial,
} from "../src/modules/subscriptions/trial-grant-reservation.service";

/* Destructive fixtures: CI disposable service ONLY, never local/production. */
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
if (!allowed) throw new Error("STOP: CI disposable MySQL 8.4 required for promotion tests.");

// Simulate reviewed identity history only in the disposable test fixture DB.
process.env.NOTETO_PROMOTION_RESERVATIONS_ENABLED = "true";
process.env.NOTETO_PROMOTION_IDENTITY_HISTORY_READY = "true";
process.env.NOTETO_TRIAL_IDENTITY_HISTORY_READY = "true";
process.env.NOTETO_TRIAL_RESERVATIONS_ENABLED = "true";

const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, database: "noteto_dev",
  user: "noteto_services", password: "ci_dummy_unused_password",
  timezone: "Z", decimalNumbers: false, connectionLimit: 8,
});
after(async () => { await db.end(); await runtimePool.end(); });

interface Row extends RowDataPacket {
  n?: number;
  status?: string;
  current_subscription_id?: string | null;
  reservation_status?: string;
  redemption_count?: number;
  token?: string;
}
async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [rows] = await db.execute<Row[]>(sql, params);
  return rows;
}

before(async () => {
  const guards = await query("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guards[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const versions = await query("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(versions[0]?.version), /^8\.4\./);
  assert.equal(versions[0]?.database_name, "noteto_dev");
  const migrations = await query(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  assert.equal(Number(migrations[0]?.n), 24);
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'billing.manage', 'CI') ON DUPLICATE KEY UPDATE `key` = `key`",
    [randomUUID()]
  );
});

interface Fixture {
  businessId: string;
  checkoutOrderId: string;
  userId: string;
  fingerprint: string;
  promotionCode: string;
  promotionId: string;
}
function uid() { return randomUUID(); }
function fingerprint() { return randomBytes(32).toString("hex"); }

async function fixture(options: {
  verified?: boolean;
  identity?: string;
  promotionId?: string;
  promotionCode?: string;
  freeMonths?: number;
  maxRedemptions?: number | null;
  promotionStatus?: "ACTIVE" | "INACTIVE" | "EXPIRED";
  withPayment?: boolean;
} = {}): Promise<Fixture> {
  const businessId = uid();
  const checkoutOrderId = uid();
  const userId = uid();
  const roleId = uid();
  const planId = uid();
  const identity = options.identity ?? fingerprint();
  const promotionId = options.promotionId ?? uid();
  const promotionCode = options.promotionCode ?? ("CI_PROMO_" + uid().replace(/-/g, "").toUpperCase());
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, "+9477" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")]
    );
    await connection.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI PROMO', 'SOLE_PROPRIETOR', 'PENDING', UTC_TIMESTAMP(3))",
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
       "VALUES (?, ?, 'CI PAID PLAN', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))"].join(" "),
      [planId, "CI_" + uid().replace(/-/g, "")]
    );
    await connection.execute(
      ["INSERT INTO checkout_orders",
       "(id, business_id, plan_id, status, amount_lkr, idempotency_key, expires_at, updated_at)",
       "VALUES (?, ?, ?, 'PENDING', 499.00, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE), UTC_TIMESTAMP(3))"].join(" "),
      [checkoutOrderId, businessId, planId, "ci_promo_order_" + uid()]
    );
    if (options.verified !== false) {
      await connection.execute(
        ["INSERT INTO verified_business_identities",
         "(id, business_id, identity_fingerprint, verification_method, evidence_reference_sha256, verified_at)",
         "VALUES (?, ?, ?, 'CI_TEST_ONLY', ?, UTC_TIMESTAMP(3))"].join(" "),
        [uid(), businessId, identity, fingerprint()]
      );
    }
    if (!options.promotionId) {
      await connection.execute(
        ["INSERT INTO promotion_codes",
         "(id, code, free_months, max_redemptions, redemption_count, status, updated_at)",
         "VALUES (?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(3))"].join(" "),
        [promotionId, promotionCode, options.freeMonths ?? 3,
         options.maxRedemptions === undefined ? 10 : options.maxRedemptions,
         options.promotionStatus ?? "ACTIVE"]
      );
    }
    if (options.withPayment) {
      await connection.execute(
        ["INSERT INTO platform_payment_transactions",
         "(id, business_id, checkout_order_id, idempotency_key, gateway,",
         "amount_lkr, status, initiation_status, updated_at)",
         "VALUES (?, ?, ?, ?, 'MOCK', 499.00, 'PENDING', 'RESERVED', UTC_TIMESTAMP(3))"].join(" "),
        [uid(), businessId, checkoutOrderId, "ci_promo_pay_" + uid()]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return { businessId, checkoutOrderId, userId, fingerprint: identity,
    promotionId, promotionCode };
}

function input(f: Fixture) {
  return { businessId: f.businessId, checkoutOrderId: f.checkoutOrderId,
    userId: f.userId, promotionCode: f.promotionCode };
}
function hasCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PromotionReservationError);
    assert.equal(error.code, code);
    return true;
  };
}

async function assertNoActivation(f: Fixture) {
  const business = await query(
    "SELECT status, current_subscription_id FROM businesses WHERE id = ?", [f.businessId]
  );
  const subscriptions = await query(
    "SELECT COUNT(*) AS n FROM business_subscriptions WHERE business_id = ?", [f.businessId]
  );
  const payments = await query(
    "SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id = ?", [f.businessId]
  );
  assert.equal(business[0]?.status, "PENDING");
  assert.equal(business[0]?.current_subscription_id, null);
  assert.equal(Number(subscriptions[0]?.n), 0);
  assert.equal(Number(payments[0]?.n), 0);
}

test("valid 3-month code reserves once, replay is read-only, no activation", async () => {
  const f = await fixture();
  const first = await reservePromotion(input(f));
  assert.equal(first.status, "RESERVED");
  assert.equal(first.replayed, false);
  assert.equal(first.freeMonths, 3);
  const again = await reservePromotion(input(f));
  assert.equal(again.redemptionId, first.redemptionId);
  assert.equal(again.replayed, true);
  const quota = await query("SELECT redemption_count FROM promotion_codes WHERE id = ?", [f.promotionId]);
  assert.equal(Number(quota[0]?.redemption_count), 1);
  const checkout = await query("SELECT status FROM checkout_orders WHERE id = ?", [f.checkoutOrderId]);
  assert.equal(checkout[0]?.status, "CANCELLED");
  const redemptions = await query(
    "SELECT COUNT(*) AS n FROM promotion_redemptions WHERE business_id = ? AND reservation_status = 'RESERVED'",
    [f.businessId]
  );
  assert.equal(Number(redemptions[0]?.n), 1);
  await assertNoActivation(f);
});

test("1-month and 6-month offers reserve their exact configured duration", async () => {
  for (const months of [1, 6]) {
    const f = await fixture({ freeMonths: months });
    const result = await reservePromotion(input(f));
    assert.equal(result.freeMonths, months);
    assert.equal(result.status, "RESERVED");
    await assertNoActivation(f);
  }
});

test("expired promotion is rejected without consuming a quota unit", async () => {
  const f = await fixture();
  await db.execute("UPDATE promotion_codes SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?", [f.promotionId]);
  await assert.rejects(() => reservePromotion(input(f)), hasCode("PROMOTION_EXPIRED"));
  const quota = await query("SELECT redemption_count FROM promotion_codes WHERE id = ?", [f.promotionId]);
  assert.equal(Number(quota[0]?.redemption_count), 0);
});

test("unverified business fails closed without cancelling checkout or consuming quota", async () => {
  const f = await fixture({ verified: false });
  await assert.rejects(() => reservePromotion(input(f)), hasCode("BUSINESS_IDENTITY_NOT_VERIFIED"));
  const order = await query("SELECT status FROM checkout_orders WHERE id = ?", [f.checkoutOrderId]);
  assert.equal(order[0]?.status, "PENDING");
  const quota = await query("SELECT redemption_count FROM promotion_codes WHERE id = ?", [f.promotionId]);
  assert.equal(Number(quota[0]?.redemption_count), 0);
});

test("any payment attempt blocks promotion and preserves pending order", async () => {
  const f = await fixture({ withPayment: true });
  await assert.rejects(() => reservePromotion(input(f)), hasCode("PAYMENT_RECONCILIATION_REQUIRED"));
  const order = await query("SELECT status FROM checkout_orders WHERE id = ?", [f.checkoutOrderId]);
  assert.equal(order[0]?.status, "PENDING");
});

test("inactive and unsupported promotional codes cannot reserve", async () => {
  for (const f of [
    await fixture({ promotionStatus: "INACTIVE" }),
    await fixture({ freeMonths: 2 }),
  ]) {
    await assert.rejects(() => reservePromotion(input(f)));
    const quota = await query("SELECT redemption_count FROM promotion_codes WHERE id = ?", [f.promotionId]);
    assert.equal(Number(quota[0]?.redemption_count), 0);
  }
});

test("one quota redemption is shared across two verified businesses", async () => {
  const first = await fixture({ maxRedemptions: 1 });
  const second = await fixture({ promotionId: first.promotionId, promotionCode: first.promotionCode });
  await reservePromotion(input(first));
  await assert.rejects(() => reservePromotion(input(second)), hasCode("PROMOTION_LIMIT_REACHED"));
  const quota = await query("SELECT redemption_count FROM promotion_codes WHERE id = ?", [first.promotionId]);
  assert.equal(Number(quota[0]?.redemption_count), 1);
});

test("shared identity cannot redeem multiple codes concurrently", async () => {
  const identity = fingerprint();
  const first = await fixture({ identity });
  const second = await fixture({ identity });
  const results = await Promise.allSettled([
    reservePromotion(input(first)), reservePromotion(input(second)),
  ]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const claims = await query("SELECT COUNT(*) AS n FROM identity_offer_claims WHERE identity_fingerprint = ?", [identity]);
  assert.equal(Number(claims[0]?.n), 1);
  const reservations = await query(
    "SELECT COUNT(*) AS n FROM promotion_redemptions WHERE identity_fingerprint = ?", [identity]
  );
  assert.equal(Number(reservations[0]?.n), 1);
});

test("a trial reservation blocks promotion for the same identity", async () => {
  const identity = fingerprint();
  const trial = await fixture({ identity });
  const promo = await fixture({ identity });
  await reserveIntroductoryTrial({
    businessId: trial.businessId, checkoutOrderId: trial.checkoutOrderId, userId: trial.userId,
  });
  await assert.rejects(() => reservePromotion(input(promo)));
  const count = await query("SELECT COUNT(*) AS n FROM identity_offer_claims WHERE identity_fingerprint = ?", [identity]);
  assert.equal(Number(count[0]?.n), 1);
});

test("a promotion reservation blocks trial for the same identity", async () => {
  const identity = fingerprint();
  const promo = await fixture({ identity });
  const trial = await fixture({ identity });
  await reservePromotion(input(promo));
  await assert.rejects(() => reserveIntroductoryTrial({
    businessId: trial.businessId, checkoutOrderId: trial.checkoutOrderId, userId: trial.userId,
  }));
  const count = await query("SELECT COUNT(*) AS n FROM identity_offer_claims WHERE identity_fingerprint = ?", [identity]);
  assert.equal(Number(count[0]?.n), 1);
});

test("production guard rejects without DB connection", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => reservePromotion(input(f), async () => { throw new Error("UNEXPECTED_DB_CONNECTION"); }),
      hasCode("PROMOTION_RESERVATION_DISABLED")
    );
  } finally { process.env.NODE_ENV = "development"; }
});

test("history readiness guard rejects without DB connection", async () => {
  const f = await fixture();
  try {
    process.env.NOTETO_PROMOTION_IDENTITY_HISTORY_READY = "false";
    await assert.rejects(
      () => reservePromotion(input(f), async () => { throw new Error("UNEXPECTED_DB_CONNECTION"); }),
      hasCode("IDENTITY_HISTORY_NOT_READY")
    );
  } finally { process.env.NOTETO_PROMOTION_IDENTITY_HISTORY_READY = "true"; }
});

console.log("INFO: Promotion reservations are tested only with disposable MySQL 8.4.");
