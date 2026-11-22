import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  evaluateBusinessHoldCapability, SubscriptionHoldAccessError,
} from "../src/modules/subscriptions/subscription-hold-access.service";

/* DESTRUCTIVE TEST FIXTURES: disposable GitHub Actions MySQL 8.4 ONLY. */
const guard =
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

if (!guard) throw new Error("STOP: Only disposable GitHub Actions MySQL 8.4 is permitted.");

process.env.NOTETO_SUBSCRIPTION_HOLD_POLICY_ENABLED = "true";
const db = mysql.createPool({
  host: "127.0.0.1", port: 3307,
  user: "noteto_services", password: "ci_dummy_unused_password",
  database: "noteto_dev", timezone: "Z", decimalNumbers: false,
  connectionLimit: 5,
});
after(async () => { await db.end(); await runtimePool.end(); });

interface Row extends RowDataPacket { n?: number; token?: string }
const uid = () => randomUUID();
async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await db.execute<Row[]>(sql, params);
  return result;
}

before(async () => {
  const marker = await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(marker[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const version = await rows("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(version[0]?.version), /^8\.4\./);
  assert.equal(version[0]?.database_name, "noteto_dev");
  const migrations = await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
  assert.equal(Number(migrations[0]?.n), 20);
  for (const key of ["business.read", "business.manage", "transactions.read",
    "transactions.update", "transactions.create", "reports.read"]) {
    await db.execute(
      "INSERT INTO permissions (id, `key`, description) VALUES (?, ?, 'CI hold policy') ON DUPLICATE KEY UPDATE `key` = `key`",
      [uid(), key]
    );
  }
});

interface Fixture { businessId: string; userId: string; subscriptionId: string; roleId: string }
async function fixture(
  subscriptionStatus: "PAST_DUE" | "ACTIVE" | "CANCELLED" = "PAST_DUE",
  businessStatus: "ACTIVE" | "SUSPENDED" = "ACTIVE"
): Promise<Fixture> {
  const businessId = uid(), userId = uid(), roleId = uid();
  const planId = uid(), subscriptionId = uid();
  const phone = "+9477" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  const con = await db.getConnection();
  try {
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, phone]
    );
    await con.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI HOLD TEST', 'SOLE_PROPRIETOR', ?, UTC_TIMESTAMP(3))",
      [businessId, businessStatus]
    );
    await con.execute(
      "INSERT INTO roles (id, business_id, name, is_system_role, updated_at) VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))",
      [roleId, businessId]
    );
    await con.execute(
      [
        "INSERT INTO role_permissions (role_id, permission_id)",
        "SELECT ?, id FROM permissions",
        "WHERE `key` IN ('business.read', 'business.manage', 'transactions.read',",
        "'transactions.update', 'transactions.create', 'reports.read')",
      ].join(" "),
      [roleId]
    );
    await con.execute(
      "INSERT INTO business_memberships (id, business_id, user_id, role_id, status, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [uid(), businessId, userId, roleId]
    );
    await con.execute(
      [
        "INSERT INTO subscription_plans",
        "(id, code, name, price_lkr, billing_interval, trial_days, invoice_limit, is_active, updated_at)",
        "VALUES (?, ?, 'CI HOLD', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))",
      ].join(" "),
      [planId, "CI_HO_" + uid().replace(/-/g, "").toUpperCase()]
    );
    await con.execute(
      [
        "INSERT INTO business_subscriptions",
        "(id, business_id, plan_id, status, starts_at, updated_at)",
        "VALUES (?, ?, ?, ?, '2026-10-01 00:00:00.000', UTC_TIMESTAMP(3))",
      ].join(" "),
      [subscriptionId, businessId, planId, subscriptionStatus]
    );
    await con.execute(
      "UPDATE businesses SET current_subscription_id = ? WHERE id = ?",
      [subscriptionId, businessId]
    );
    await con.commit();
  } catch (error) {
    await con.rollback();
    throw error;
  } finally { con.release(); }
  return { businessId, userId, subscriptionId, roleId };
}

test("past-due subscription keeps profile editable but blocks new income and report generation", async () => {
  const f = await fixture();
  const base = { businessId: f.businessId, userId: f.userId };
  const profile = await evaluateBusinessHoldCapability({ ...base, capability: "EDIT_PROFILE" });
  assert.equal(profile.mode, "HOLD");
  assert.equal(profile.allowed, true);
  const newIncome = await evaluateBusinessHoldCapability({ ...base, capability: "CREATE_INCOME" });
  assert.equal(newIncome.allowed, false);
  assert.equal(newIncome.code, "SUBSCRIPTION_ON_HOLD");
  const generate = await evaluateBusinessHoldCapability({ ...base, capability: "GENERATE_REPORT" });
  assert.equal(generate.allowed, false);
});

test("historical edit and download require resource repository proof", async () => {
  const f = await fixture();
  for (const capability of ["EDIT_PREVIOUS_ENTRY", "DOWNLOAD_SAVED_REPORT"] as const) {
    const decision = await evaluateBusinessHoldCapability({
      businessId: f.businessId, userId: f.userId, capability,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "RESOURCE_PROOF_REQUIRED");
  }
});

test("active subscription keeps create and generate capabilities", async () => {
  const f = await fixture("ACTIVE");
  for (const capability of ["CREATE_EXPENSE", "GENERATE_REPORT"] as const) {
    const permission = await evaluateBusinessHoldCapability({
      businessId: f.businessId, userId: f.userId, capability,
    });
    assert.equal(permission.mode, "FULL");
    assert.equal(permission.allowed, true);
  }
});

test("another business user cannot read or edit this business", async () => {
  const target = await fixture();
  const other = await fixture();
  await assert.rejects(
    () => evaluateBusinessHoldCapability({
      businessId: target.businessId, userId: other.userId, capability: "EDIT_PROFILE",
    }),
    (error: unknown) => {
      assert.ok(error instanceof SubscriptionHoldAccessError);
      assert.equal(error.code, "BUSINESS_ACCESS_DENIED");
      return true;
    }
  );
});

test("missing role permission is not overridden by hold allowance", async () => {
  const f = await fixture();
  await db.execute(
    [
      "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id",
      "WHERE rp.role_id = ? AND p.`key` = 'business.manage'",
    ].join(" "), [f.roleId]
  );
  await assert.rejects(
    () => evaluateBusinessHoldCapability({
      businessId: f.businessId, userId: f.userId, capability: "EDIT_PROFILE",
    }),
    (error: unknown) => {
      assert.ok(error instanceof SubscriptionHoldAccessError);
      assert.equal(error.code, "ROLE_PERMISSION_DENIED");
      return true;
    }
  );
});

test("administratively suspended business is not given overdue-payment access", async () => {
  const f = await fixture("PAST_DUE", "SUSPENDED");
  const decision = await evaluateBusinessHoldCapability({
    businessId: f.businessId, userId: f.userId, capability: "VIEW_DASHBOARD",
  });
  assert.equal(decision.mode, "LOCKED");
  assert.equal(decision.allowed, false);
});

test("production environment remains fail-closed without opening database", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => evaluateBusinessHoldCapability({
        businessId: f.businessId, userId: f.userId, capability: "EDIT_PROFILE",
      }, async () => { throw Error("UNEXPECTED_DB_CONNECTION"); }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionHoldAccessError);
        assert.equal(error.code, "HOLD_POLICY_DISABLED");
        return true;
      }
    );
  } finally { process.env.NODE_ENV = "development"; }
});
console.log("INFO: Subscription hold-access policy tested only against disposable MySQL.");
