import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  editHistoricalCashEntry, HistoricalEntryEditError,
  type HistoricalEntryEditInput,
} from "../src/modules/transactions/historical-cash-entry-edit.service";

/* DESTRUCTIVE FIXTURES: DISPOSABLE GitHub Actions MySQL 8.4 only. */
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
if (!guard) throw Error("STOP: Historical edit fixtures require disposable MySQL 8.4 CI.");
process.env.NOTETO_HISTORICAL_EDIT_ENABLED = "true";
const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, user: "noteto_services",
  password: "ci_dummy_unused_password", database: "noteto_dev",
  timezone: "Z", decimalNumbers: false, connectionLimit: 8,
});
after(async () => { await db.end(); await runtimePool.end(); });
interface Row extends RowDataPacket {
  n?: number; token?: string; amount_lkr?: string; category?: string;
  description?: string; version?: number; edited_by_user_id?: string;
  old_amount_lkr?: string; new_amount_lkr?: string; transaction_type?: string;
}
async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [r] = await db.execute<Row[]>(sql, params);
  return r;
}
const uid = () => randomUUID();
before(async () => {
  const guardRow = await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guardRow[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const database = await rows("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(database[0]?.version), /^8\.4\./);
  assert.equal(database[0]?.database_name, "noteto_dev");
  const migrations = await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
  assert.equal(Number(migrations[0]?.n), 16);
});

interface Fixture { businessId: string; userId: string; entryId: string; roleId: string }
async function fixture(options: {
  subscriptionStatus?: "ACTIVE" | "PAST_DUE";
  heldAt?: string | null;
  entryCreatedAt?: string;
  businessStatus?: "ACTIVE" | "SUSPENDED";
} = {}): Promise<Fixture> {
  const businessId = uid(), userId = uid(), entryId = uid(), roleId = uid();
  const planId = uid(), subscriptionId = uid();
  const con = await db.getConnection();
  try {
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, "+9477" + String(Math.floor(Math.random() * 10000000)).padStart(7, "0")]
    );
    await con.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI HISTORICAL', 'SOLE_PROPRIETOR', ?, UTC_TIMESTAMP(3))",
      [businessId, options.businessStatus ?? "ACTIVE"]
    );
    await con.execute(
      "INSERT INTO roles (id, business_id, name, is_system_role, updated_at) VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))",
      [roleId, businessId]
    );
    await con.execute(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE `key` = 'transactions.update'",
      [roleId]
    );
    await con.execute(
      "INSERT INTO business_memberships (id, business_id, user_id, role_id, status, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [uid(), businessId, userId, roleId]
    );
    await con.execute(
      ["INSERT INTO subscription_plans",
       "(id, code, name, price_lkr, billing_interval, trial_days, invoice_limit, is_active, updated_at)",
       "VALUES (?, ?, 'CI HIST', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_HI_"+uid().replace(/-/g,"").toUpperCase()]
    );
    await con.execute(
      ["INSERT INTO business_subscriptions",
       "(id, business_id, plan_id, status, starts_at, held_at, updated_at)",
       "VALUES (?, ?, ?, ?, '2026-09-01 00:00:00.000', ?, UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId, businessId, planId, options.subscriptionStatus ?? "PAST_DUE",
       options.heldAt === undefined ? "2026-11-01 00:00:00.000" : options.heldAt]
    );
    await con.execute(
      "UPDATE businesses SET current_subscription_id = ? WHERE id = ?", [subscriptionId, businessId]
    );
    await con.execute(
      ["INSERT INTO cash_transactions",
       "(id, business_id, created_by_user_id, transaction_type, amount_lkr, category, description,",
       "occurred_on, created_at, updated_at, version)",
       "VALUES (?, ?, ?, 'INCOME', 499.00, 'Sales', 'Original', '2026-10-20', ?, UTC_TIMESTAMP(3), 1)"].join(" "),
      [entryId, businessId, userId, options.entryCreatedAt ?? "2026-10-20 12:00:00.000"]
    );
    await con.commit();
  } catch (e) {
    await con.rollback();
    throw e;
  } finally { con.release(); }
  return { businessId, userId, entryId, roleId };
}
function editInput(f: Fixture): HistoricalEntryEditInput {
  return {
    businessId: f.businessId, userId: f.userId, transactionId: f.entryId,
    expectedVersion: 1, amountLkr: "450.00", category: "Sales corrected",
    description: "Corrected historic receipt", occurredOn: "2026-10-19",
    reason: "Fix incorrect October sale",
  };
}
function err(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HistoricalEntryEditError);
    assert.equal(error.code, code);
    return true;
  };
}

test("held customer changes existing October entry with one full before/after audit", async () => {
  const f = await fixture();
  const result = await editHistoricalCashEntry(editInput(f));
  assert.equal(result.transactionCreated, false);
  assert.equal(result.freshReportGenerated, false);
  assert.equal(result.version, 2);
  const entry = await rows("SELECT amount_lkr, category, description, transaction_type, version FROM cash_transactions WHERE id = ?", [f.entryId]);
  assert.equal(String(entry[0]?.amount_lkr), "450.00");
  assert.equal(entry[0]?.category, "Sales corrected");
  assert.equal(entry[0]?.transaction_type, "INCOME");
  assert.equal(entry[0]?.version, 2);
  const audits = await rows(
    "SELECT old_amount_lkr, new_amount_lkr, edited_by_user_id FROM cash_transaction_edit_audits WHERE cash_transaction_id = ?",
    [f.entryId]
  );
  assert.equal(audits.length, 1);
  assert.equal(String(audits[0]?.old_amount_lkr), "499.00");
  assert.equal(String(audits[0]?.new_amount_lkr), "450.00");
  assert.equal(audits[0]?.edited_by_user_id, f.userId);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM archived_report_snapshots WHERE business_id = ?",[f.businessId]))[0]?.n),0);
});

test("old version cannot overwrite an already corrected entry", async () => {
  const f = await fixture();
  await editHistoricalCashEntry(editInput(f));
  await assert.rejects(()=>editHistoricalCashEntry(editInput(f)),err("ENTRY_VERSION_CONFLICT"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id = ?",[f.entryId]))[0]?.n),1);
});

test("a fake entry id cannot be created using edit", async () => {
  const f=await fixture(),missing=uid();
  await assert.rejects(()=>editHistoricalCashEntry({...editInput(f),transactionId:missing}),
    err("EXISTING_ENTRY_NOT_FOUND"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id = ?",[f.businessId]))[0]?.n),1);
});

test("another tenant's entry cannot be edited",async()=>{
  const a=await fixture(),b=await fixture();
  await assert.rejects(()=>editHistoricalCashEntry({...editInput(a),transactionId:b.entryId}),
    err("EXISTING_ENTRY_NOT_FOUND"));
});

test("a post-hold-created entry cannot be changed, even if backdated",async()=>{
  const f=await fixture({entryCreatedAt:"2026-11-02 12:00:00.000"});
  await assert.rejects(()=>editHistoricalCashEntry(editInput(f)),err("ENTRY_NOT_PRE_HOLD"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id = ?",[f.entryId]))[0]?.n),0);
});

test("cannot move a previous entry into a new post-hold transaction date",async()=>{
  const f=await fixture();
  await assert.rejects(()=>editHistoricalCashEntry({...editInput(f),occurredOn:"2026-12-12"}),
    err("ENTRY_NOT_PRE_HOLD"));
});

test("missing audited hold timestamp rejects historical edit",async()=>{
  const f=await fixture({heldAt:null});
  await assert.rejects(()=>editHistoricalCashEntry(editInput(f)),err("REVIEWED_HOLD_REQUIRED"));
});

test("missing edit permission rejects request",async()=>{
  const f=await fixture();
  await db.execute(
    ["DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id",
     "WHERE rp.role_id = ? AND p.`key` = 'transactions.update'"].join(" "),
    [f.roleId]
  );
  await assert.rejects(()=>editHistoricalCashEntry(editInput(f)),err("ENTRY_EDIT_PERMISSION_DENIED"));
});

test("administratively suspended business is locked",async()=>{
  const f=await fixture({businessStatus:"SUSPENDED"});
  await assert.rejects(()=>editHistoricalCashEntry(editInput(f)),err("BUSINESS_NOT_AVAILABLE"));
});

test("two concurrent revisions with identical expected version leave one audited change",async()=>{
  const f=await fixture();
  const results=await Promise.allSettled([
    editHistoricalCashEntry(editInput(f)),
    editHistoricalCashEntry({...editInput(f),amountLkr:"480.00",reason:"Correct source total"}),
  ]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id = ?",[f.entryId]))[0]?.n),1);
  assert.equal(Number((await rows("SELECT version FROM cash_transactions WHERE id = ?",[f.entryId]))[0]?.version),2);
});

test("invalid amounts and missing reason fail closed before DB access",async()=>{
  const f=await fixture();
  for(const input of [
    {...editInput(f),amountLkr:"0.00"},
    {...editInput(f),amountLkr:"-1.00"},
    {...editInput(f),occurredOn:"2026-02-30"},
    {...editInput(f),reason:""},
  ]) {
    await assert.rejects(()=>editHistoricalCashEntry(input,async()=>{throw Error("UNEXPECTED_DB");}),
      err("INVALID_ENTRY_CORRECTION"));
  }
});

test("production mode disables edits before DB connection",async()=>{
  const f=await fixture();
  try {
    process.env.NODE_ENV="production";
    await assert.rejects(
      ()=>editHistoricalCashEntry(editInput(f),async()=>{throw Error("UNEXPECTED_DB");}),
      err("HISTORICAL_EDIT_DISABLED")
    );
  }finally {process.env.NODE_ENV="development";}
});
