import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import mysql, { type RowDataPacket } from "mysql2/promise";

import authRouter from "../src/routes/auth.routes";
import {
  createRegistrationCheckout,
  RegistrationCheckoutError,
  type RegistrationCheckoutInput,
} from "../src/modules/checkout/registration-checkout.service";

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

if (!guard) {
  throw new Error("STOP: Only a disposable GitHub Actions MySQL 8.4 database is permitted.");
}

const pool = mysql.createPool({
  host: "127.0.0.1", port: 3307,
  user: "noteto_services", password: "ci_dummy_unused_password",
  database: "noteto_dev",
  timezone: "Z", decimalNumbers: false,
  connectionLimit: 5,
});

after(async () => pool.end());

interface DbRow extends RowDataPacket {
  id?: string;
  n?: number;
  status?: string;
  amount_lkr?: string;
  current_subscription_id?: string | null;
}

async function query(sql: string, values: unknown[] = []): Promise<DbRow[]> {
  const [rows] = await pool.execute<DbRow[]>(sql, values);
  return rows;
}

const permissions = [
  "billing.manage", "business.manage", "business.read",
  "invoices.manage", "invoices.read", "members.manage", "members.read",
  "reports.read", "transactions.create", "transactions.delete",
  "transactions.read", "transactions.update",
];

before(async () => {
  const guardRows = await query(
    "SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"
  );
  assert.equal(guardRows[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");

  const version = await query("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(version[0]?.version), /^8\.4\./);
  assert.equal(version[0]?.database_name, "noteto_dev");

  for (const key of permissions) {
    await pool.execute(
      "INSERT INTO permissions (id, \`key\`, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE \`key\` = \`key\`",
      [randomUUID(), key, "CI disposable permission"]
    );
  }
  const count = await query("SELECT COUNT(*) AS n FROM permissions");
  assert.equal(Number(count[0]?.n), 12);
});

function phone(): string {
  // 12 digits total including the international prefix after the '+'.
  return "+9477" + String(Math.floor(Math.random() * 10000000)).padStart(7, "0");
}

async function plan(price = "499.00", trialDays = 0) {
  const id = randomUUID();
  const code = "CI_" + randomUUID().replace(/-/g, "").toUpperCase();
  await pool.execute(
    [
      "INSERT INTO subscription_plans",
      "(id, code, name, price_lkr, billing_interval, trial_days,",
      "invoice_limit, is_active, updated_at)",
      "VALUES (?, ?, 'CI STANDARD', ?, 'MONTHLY', ?, 30, 1, UTC_TIMESTAMP(3))",
    ].join(" "),
    [id, code, price, trialDays]
  );
  return { id, code };
}

function data(planCode: string): RegistrationCheckoutInput {
  return {
    phone: phone(),
    fullName: "CI Pending Owner",
    businessName: "CI Pending MSME",
    registrationType: "SOLE_PROPRIETOR",
    preferredLanguage: "ta",
    planCode,
    idempotencyKey: "register_" + randomUUID(),
  };
}

function hasCode(code: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof RegistrationCheckoutError);
    assert.equal(err.code, code);
    return true;
  };
}

test("OTP-backed registration creates pending account and checkout atomically", async () => {
  const p = await plan();
  const input = data(p.code);
  const created = await createRegistrationCheckout(input);
  assert.equal(created.planCode, p.code);
  assert.equal(created.amountLkr, "499.00");

  const user = await query("SELECT id FROM users WHERE id = ?", [created.userId]);
  const business = await query(
    "SELECT status, current_subscription_id FROM businesses WHERE id = ?", [created.businessId]
  );
  const owner = await query(
    "SELECT COUNT(*) AS n FROM business_memberships WHERE business_id = ? AND user_id = ? AND status = 'ACTIVE'",
    [created.businessId, created.userId]
  );
  const granted = await query(
    [
      "SELECT COUNT(*) AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id",
      "WHERE r.business_id = ? AND r.name = 'OWNER'",
    ].join(" "),
    [created.businessId]
  );
  const checkout = await query(
    "SELECT status, amount_lkr FROM checkout_orders WHERE id = ? AND business_id = ?",
    [created.checkoutOrderId, created.businessId]
  );
  assert.equal(user.length, 1);
  assert.equal(business[0].status, "PENDING");
  assert.equal(business[0].current_subscription_id, null);
  assert.equal(Number(owner[0]?.n), 1);
  assert.equal(Number(granted[0]?.n), 12);
  assert.equal(checkout[0].status, "PENDING");
  assert.equal(checkout[0].amount_lkr, "499.00");
});

test("repeated idempotency key rejects a second user or business", async () => {
  const p = await plan();
  const input = data(p.code);
  await createRegistrationCheckout(input);
  const another = { ...data(p.code), idempotencyKey: input.idempotencyKey };
  await assert.rejects(
    () => createRegistrationCheckout(another),
    hasCode("IDEMPOTENCY_KEY_ALREADY_USED")
  );
  const users = await query("SELECT COUNT(*) AS n FROM users WHERE phone = ?", [another.phone]);
  assert.equal(Number(users[0].n), 0);
});

test("same phone with a new key cannot create duplicate business", async () => {
  const p = await plan();
  const input = data(p.code);
  await createRegistrationCheckout(input);
  await assert.rejects(
    () => createRegistrationCheckout({ ...input, idempotencyKey: "retry_" + randomUUID() }),
    hasCode("PHONE_ALREADY_REGISTERED")
  );
  const orders = await query(
    [
      "SELECT COUNT(*) AS n FROM checkout_orders co",
      "JOIN businesses b ON b.id = co.business_id",
      "JOIN business_memberships bm ON bm.business_id = b.id",
      "JOIN users u ON u.id = bm.user_id WHERE u.phone = ?",
    ].join(" "),
    [input.phone]
  );
  assert.equal(Number(orders[0].n), 1);
});

test("trial-bearing and zero-price plans are not silently charged or activated", async () => {
  for (const config of [{ price: "499.00", trialDays: 90 }, { price: "0.00", trialDays: 0 }]) {
    const p = await plan(config.price, config.trialDays);
    const input = data(p.code);
    await assert.rejects(
      () => createRegistrationCheckout(input),
      hasCode("PLAN_NOT_ELIGIBLE_FOR_PAID_CHECKOUT")
    );
    const account = await query("SELECT COUNT(*) AS n FROM users WHERE phone = ?", [input.phone]);
    assert.equal(Number(account[0]?.n), 0);
  }
});

test("disabled runtime rejects registration before a database connection", async () => {
  const p = await plan();
  const input = data(p.code);
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => createRegistrationCheckout(input, async () => {
        throw new Error("UNEXPECTED_DATABASE_CONNECTION");
      }),
      hasCode("REGISTRATION_CHECKOUT_DISABLED")
    );
  } finally {
    process.env.NODE_ENV = "development";
  }
});

test("HTTP endpoint requires matching Origin and recent verified-OTP session", async () => {
  const p = await plan();
  const app = express();
  const nonce = randomUUID();
  const stored = new session.MemoryStore();
  app.use(express.json());
  app.use(session({
    secret: randomUUID() + randomUUID(),
    resave: false, saveUninitialized: false, store: stored,
    name: "noteto.sid",
    cookie: { httpOnly: true, sameSite: "lax" },
  }));

  // Test-only identity fixture. It is never registered on the actual API.
  app.post("/__ci/mint", (req, res, next) => {
    if (req.get("X-CI-Nonce") !== nonce) return res.sendStatus(403);
    req.session.verifiedPhone = phone();
    req.session.verifiedPhoneAt =
      req.get("X-CI-Expired") === "true" ? Date.now() - 3600000 : Date.now();
    req.session.save(err => err ? next(err) : res.json({ phone: req.session.verifiedPhone }));
  });
  app.use("/api/auth", authRouter);
  const server = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const base = "http://127.0.0.1:" + port;

    async function send(
      endpoint: string,
      payload: unknown,
      cookie?: string,
      origin = "http://localhost:5173",
      headers: Record<string, string> = {}
    ) {
      const response = await fetch(base + endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "Idempotency-Key": "register_" + randomUUID(),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: JSON.stringify(payload),
      });
      return {
        status: response.status,
        body: await response.json() as Record<string, unknown>,
        cookie: response.headers.get("set-cookie")?.split(";")[0] ?? null,
      };
    }

    const body = {
      full_name: "CI API Owner",
      business_name: "CI API MSME",
      business_type: "sole_proprietor",
      preferred_language: "en",
      plan_code: p.code,
    };

    const unauthenticated = await send("/api/auth/register-checkout", body);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.code, "RECENT_PHONE_VERIFICATION_REQUIRED");

    const minted = await send("/__ci/mint", {}, undefined, "http://localhost:5173", {
      "X-CI-Nonce": nonce,
    });
    assert.equal(minted.status, 200);
    assert.ok(minted.cookie);

    const forged = await send(
      "/api/auth/register-checkout", body, minted.cookie!, "https://evil.example"
    );
    assert.equal(forged.status, 403);
    assert.equal(forged.body.code, "CHECKOUT_ORIGIN_DENIED");

    const missingKey = await send(
      "/api/auth/register-checkout", body, minted.cookie!, "http://localhost:5173",
      { "Idempotency-Key": "short" }
    );
    assert.equal(missingKey.status, 400);

    const created = await send("/api/auth/register-checkout", body, minted.cookie!);
    assert.equal(created.status, 201);
    assert.equal(created.body.payment_required, true);
    assert.equal((created.body.business as {status: string}).status, "PENDING");
    assert.equal((created.body.checkout as {status: string}).status, "PENDING");

    const legacy = await send("/api/auth/register", body, minted.cookie!);
    assert.equal(legacy.status, 410);
    assert.equal(legacy.body.code, "PAYMENT_FIRST_REGISTRATION_REQUIRED");

    const expired = await send("/__ci/mint", {}, undefined, "http://localhost:5173", {
      "X-CI-Nonce": nonce,
      "X-CI-Expired": "true",
    });
    assert.equal(expired.status, 200);
    const stale = await send("/api/auth/register-checkout", body, expired.cookie!);
    assert.equal(stale.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    stored.close();
  }
});

console.log("INFO: Registration and checkout integration uses only disposable CI MySQL.");
