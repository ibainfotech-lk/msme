import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import session from "express-session";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  editHistoricalCashEntry, HistoricalEntryEditError,
  type HistoricalEntryEditInput,
} from "../src/modules/transactions/historical-cash-entry-edit.service";
import { listPreviousEntries, listPreviouslyGeneratedReports, HeldHistoryError } from "../src/modules/subscriptions/held-history-list.service";
import heldHistoryRouter from "../src/modules/subscriptions/held-history.routes";
import {
  getHeldProfile, updateHeldProfile, HeldProfileError,
} from "../src/modules/subscriptions/held-profile.service";

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
process.env.NOTETO_HOLD_HISTORY_API_ENABLED = "true";
process.env.NOTETO_SUBSCRIPTION_HOLD_POLICY_ENABLED = "true";
process.env.NOTETO_HELD_PROFILE_EDIT_ENABLED = "true";
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
  assert.equal(Number(migrations[0]?.n), 25);
  // Make this suite independent of whether another integration test seeded
  // the business.manage permission earlier in the CI job.
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'business.manage', 'CI profile') ON DUPLICATE KEY UPDATE `key` = `key`",
    [uid()]
  );
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
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE `key` IN ('transactions.update','transactions.read','reports.read','business.read','business.manage')",
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


test("held history lists only transactions created before the trusted hold",async()=>{
  const f=await fixture();
  await db.execute(
    ["INSERT INTO cash_transactions",
     "(id,business_id,created_by_user_id,transaction_type,amount_lkr,category,description,occurred_on,created_at,updated_at,version)",
     "VALUES (?,?,?,'EXPENSE',150.00,'Supplies','Backdated but created after hold','2026-10-10','2026-11-02 12:00:00.000',UTC_TIMESTAMP(3),1)"].join(" "),
    [uid(),f.businessId,f.userId]
  );
  const history=await listPreviousEntries({businessId:f.businessId,userId:f.userId});
  assert.equal(history.mode,"HOLD");
  assert.equal(history.items.length,1);
  assert.equal(history.items[0].id,f.entryId);
  assert.equal(history.items[0].type,"INCOME");
  assert.equal(history.newEntryAllowed,false);
  assert.equal(history.reportGenerationAllowed,false);
});

test("report list exposes only saved snapshots generated on/before the hold",async()=>{
  const f=await fixture();
  const [subs]=await db.execute<Row[]>(
    "SELECT current_subscription_id AS token FROM businesses WHERE id = ?",[f.businessId]
  );
  const subscriptionId=String(subs[0].token);
  const bytes=Buffer.from("%PDF-1.4\nArchived CI\n%%EOF");
  const checksum=createHash("sha256").update(bytes).digest("hex");
  const oldId=uid(),newId=uid();
  for(const [reportId,generatedAt] of [
    [oldId,"2026-10-31 12:00:00.000"],
    [newId,"2026-11-02 12:00:00.000"],
  ]) {
    await db.execute(
      ["INSERT INTO archived_report_snapshots",
       "(id,business_id,subscription_id,generated_by_user_id,report_type,period_start,period_end,content_sha256,content_length,pdf_bytes,generated_at)",
       "VALUES (?,?,?,?,'DAILY','2026-10-01','2026-10-01',?,?,?,?)"].join(" "),
      [reportId,f.businessId,subscriptionId,f.userId,checksum,bytes.length,bytes,generatedAt]
    );
  }
  const history=await listPreviouslyGeneratedReports({businessId:f.businessId,userId:f.userId});
  assert.equal(history.mode,"HOLD");
  assert.deepEqual(history.items.map(x=>x.id),[oldId]);
  assert.equal(history.reportGenerationAllowed,false);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM archived_report_snapshots WHERE business_id = ?",[f.businessId]))[0]?.n),2);
});

test("history listings enforce tenant permissions",async()=>{
  const a=await fixture(),b=await fixture();
  await assert.rejects(
    ()=>listPreviousEntries({businessId:a.businessId,userId:b.userId}),
    (e:unknown)=>{
      assert.ok(e instanceof HeldHistoryError);
      assert.equal(e.code,"HISTORY_PERMISSION_DENIED");
      return true;
    }
  );
});

test("missing reviewed hold timestamp fails closed for previous-entry listing",async()=>{
  const f=await fixture({heldAt:null});
  await assert.rejects(
    ()=>listPreviousEntries({businessId:f.businessId,userId:f.userId}),
    (e:unknown)=>{
      assert.ok(e instanceof HeldHistoryError);
      assert.equal(e.code,"REVIEWED_HOLD_TIMESTAMP_REQUIRED");
      return true;
    }
  );
});

test("active accounts may list existing records without creating new ones",async()=>{
  const f=await fixture({subscriptionStatus:"ACTIVE",heldAt:null});
  const history=await listPreviousEntries({businessId:f.businessId,userId:f.userId});
  assert.equal(history.mode,"FULL");
  assert.equal(history.items.length,1);
  assert.equal(history.newEntryAllowed,false);
});

test("production guard rejects held history listing before DB connection",async()=>{
  const f=await fixture();
  try {
    process.env.NODE_ENV="production";
    await assert.rejects(
      ()=>listPreviousEntries({businessId:f.businessId,userId:f.userId},async()=>{throw Error("UNEXPECTED_DB");}),
      (e:unknown)=>{
        assert.ok(e instanceof HeldHistoryError);
        assert.equal(e.code,"HOLD_HISTORY_DISABLED");
        return true;
      }
    );
  }finally {process.env.NODE_ENV="development";}
});


test("authenticated HTTP access reports HOLD and blocks forged historical edits", async () => {
  const f = await fixture();
  const nonce = uid();
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use(session({
    name: "noteto.sid",
    secret: "noteto-disposable-ci-only-session-secret-for-hold-history",
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  }));
  app.post("/__ci/mint", (req, res, next) => {
    if (req.get("X-CI-Nonce") !== nonce) {
      res.sendStatus(403);
      return;
    }
    req.session.userId = f.userId;
    req.session.save(err => err ? next(err) : res.json({ success: true }));
  });
  app.use("/api/hold-history", heldHistoryRouter);
  const server = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const path = "/api/hold-history/businesses/" + f.businessId;
    const unauth = await fetch(base + path + "/access");
    assert.equal(unauth.status, 401);
    const minted = await fetch(base + "/__ci/mint", {
      method: "POST", headers: { "X-CI-Nonce": nonce },
    });
    assert.equal(minted.status, 200);
    const cookie = minted.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const access = await fetch(base + path + "/access", { headers: { Cookie: cookie } });
    assert.equal(access.status, 200);
    const accessData = await access.json() as Record<string, unknown>;
    assert.equal(accessData.mode, "HOLD");
    const listed = await fetch(base + path + "/entries", { headers: { Cookie: cookie } });
    assert.equal(listed.status, 200);
    const history = await listed.json() as { mode: string; items: unknown[] };
    assert.equal(history.mode, "HOLD");
    assert.equal(history.items.length, 1);

    const entryUrl = base + path + "/entries/" + f.entryId;
    const patchBody = JSON.stringify({
      expectedVersion: 1, amountLkr: "450.00",
      category: "Sales corrected", description: "October correction",
      occurredOn: "2026-10-19", reason: "Incorrect original receipt",
    });
    const noOrigin = await fetch(entryUrl, {
      method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: patchBody,
    });
    assert.equal(noOrigin.status, 403);
    const forged = await fetch(entryUrl, {
      method: "PATCH",
      headers: {
        Cookie: cookie, "Content-Type": "application/json",
        Origin: "https://malicious.example",
      },
      body: patchBody,
    });
    assert.equal(forged.status, 403);
    assert.equal(Number((await rows(
      "SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id = ?",
      [f.entryId]
    ))[0]?.n), 0);

    const valid = await fetch(entryUrl, {
      method: "PATCH",
      headers: {
        Cookie: cookie, "Content-Type": "application/json",
        Origin: "http://localhost:5173",
      },
      body: patchBody,
    });
    assert.equal(valid.status, 200);
    const edited = await valid.json() as { success: boolean; version: number };
    assert.equal(edited.success, true);
    assert.equal(edited.version, 2);
    assert.equal(Number((await rows(
      "SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id = ?",
      [f.entryId]
    ))[0]?.n), 1);

    const forbiddenCreate = await fetch(base + path + "/entries", {
      method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173" },
      body: "{}",
    });
    assert.equal(forbiddenCreate.status, 405);
    const forbiddenGenerate = await fetch(base + path + "/reports", {
      method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:5173" },
      body: "{}",
    });
    assert.equal(forbiddenGenerate.status, 405);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("held customer edits contact and personal profile with atomic audit; identity and finances stay unchanged", async () => {
  const f = await fixture();
  const before = await getHeldProfile({ businessId: f.businessId, userId: f.userId });
  assert.equal(before.version, 0);
  assert.equal(before.mode, "HOLD");
  const phoneBefore = before.personalPhone;
  const saved = await updateHeldProfile({
    businessId: f.businessId, userId: f.userId,
    expectedVersion: 0, fullName: "Testing Owner",
    preferredLanguage: "ta", displayName: "Shop Display",
    contactEmail: "contact@example.com", address: "Jaffna, Sri Lanka",
  });
  assert.equal(saved.version, 1);
  assert.equal(saved.financeModified, false);
  const afterProfile = await getHeldProfile({ businessId: f.businessId, userId: f.userId });
  assert.equal(afterProfile.profile.fullName, "Testing Owner");
  assert.equal(afterProfile.profile.preferredLanguage, "ta");
  assert.equal(afterProfile.profile.displayName, "Shop Display");
  assert.equal(afterProfile.version, 1);
  assert.equal(afterProfile.personalPhone, phoneBefore);
  assert.equal(afterProfile.businessLegalName, before.businessLegalName);
  const audits = await rows(
    "SELECT COUNT(*) AS n FROM business_profile_edit_audits WHERE business_id = ?", [f.businessId]
  );
  assert.equal(Number(audits[0]?.n), 1);
  const original = await rows("SELECT amount_lkr FROM cash_transactions WHERE id = ?", [f.entryId]);
  assert.equal(String(original[0]?.amount_lkr), "499.00");
  const sub = await rows("SELECT status AS token FROM business_subscriptions WHERE id = (SELECT current_subscription_id FROM businesses WHERE id = ?)", [f.businessId]);
  assert.equal(String(sub[0]?.token), "PAST_DUE");
});

test("stale profile version cannot override a successful correction", async () => {
  const f = await fixture();
  const input = {
    businessId: f.businessId, userId: f.userId,
    expectedVersion: 0, fullName: "Account Manager",
    preferredLanguage: "en" as const, displayName: "Shop One",
    contactEmail: "", address: "Jaffna",
  };
  await updateHeldProfile(input);
  await assert.rejects(() => updateHeldProfile({ ...input, displayName: "Shop Two" }),
    (error: unknown) => {
      assert.ok(error instanceof HeldProfileError);
      assert.equal(error.code, "PROFILE_VERSION_CONFLICT");
      return true;
    });
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM business_profile_edit_audits WHERE business_id = ?", [f.businessId]
  ))[0]?.n), 1);
});

test("member of another business cannot modify this business profile", async () => {
  const a = await fixture(), b = await fixture();
  await assert.rejects(() => updateHeldProfile({
    businessId: a.businessId, userId: b.userId, expectedVersion: 0,
    fullName: "Unauthorized User", preferredLanguage: "en",
    displayName: "Changed Store", contactEmail: "", address: "",
  }), (error: unknown) => {
    assert.ok(error instanceof HeldProfileError);
    assert.equal(error.code, "PROFILE_PERMISSION_DENIED");
    return true;
  });
});

test("missing hold timestamp and invalid contact email reject profile edits", async () => {
  const f = await fixture({ heldAt: null });
  await assert.rejects(() => getHeldProfile({ businessId: f.businessId, userId: f.userId }),
    (error: unknown) => {
      assert.ok(error instanceof HeldProfileError);
      assert.equal(error.code, "REVIEWED_HOLD_REQUIRED");
      return true;
    });
  const other = await fixture();
  assert.throws(() => updateHeldProfile({
    businessId: other.businessId, userId: other.userId,
    expectedVersion: 0, fullName: "Valid Owner", preferredLanguage: "en",
    displayName: "Store", contactEmail: "not-an-email", address: "",
  }, async () => { throw new Error("UNEXPECTED_DB"); }), (error: unknown) => {
    assert.ok(error instanceof HeldProfileError);
    assert.equal(error.code, "INVALID_PROFILE_DETAILS");
    return true;
  });
});

test("concurrent contact updates serialize by business and make one audit revision", async () => {
  const f = await fixture();
  const input = {
    businessId: f.businessId, userId: f.userId,
    expectedVersion: 0, fullName: "Store Owner",
    preferredLanguage: "en" as const, contactEmail: "",
    address: "Jaffna", displayName: "Store Alpha",
  };
  const result = await Promise.allSettled([
    updateHeldProfile(input), updateHeldProfile({ ...input, displayName: "Store Beta" }),
  ]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM business_profile_edit_audits WHERE business_id = ?", [f.businessId]
  ))[0]?.n), 1);
});

test("hold profile is disabled in production even before any DB access", async () => {
  const f = await fixture();
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => getHeldProfile({ businessId: f.businessId, userId: f.userId },
        async () => { throw new Error("UNEXPECTED_DB"); }),
      (error: unknown) => {
        assert.ok(error instanceof HeldProfileError);
        assert.equal(error.code, "HELD_PROFILE_DISABLED");
        return true;
      }
    );
  } finally { process.env.NODE_ENV = "development"; }
});

test("profile HTTP endpoint requires session, same origin and strict editable fields", async () => {
  const f = await fixture();
  const nonce = uid();
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use(session({
    name: "noteto.sid", secret: "noteto-ci-disposable-profile-session-secret",
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  }));
  app.post("/__ci/profile-login", (req, res, next) => {
    if (req.get("X-CI-Nonce") !== nonce) { res.sendStatus(403); return; }
    req.session.userId = f.userId;
    req.session.save(error => error ? next(error) : res.json({ success: true }));
  });
  app.use("/api/hold-history", heldHistoryRouter);
  const server = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const url = origin + "/api/hold-history/businesses/" + f.businessId + "/profile";
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(origin + "/__ci/profile-login", {
      method: "POST", headers: { "X-CI-Nonce": nonce },
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const profile = await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(profile.status, 200);
    const profileData = await profile.json() as {
      mode: string; version: number; businessLegalName: string;
    };
    assert.equal(profileData.mode, "HOLD");
    assert.equal(profileData.version, 0);
    const patch = {
      expectedVersion: 0, fullName: "Edited via HTTP",
      preferredLanguage: "si", displayName: "Public Contact Name",
      contactEmail: "shop@example.lk", address: "Northern Province",
    };
    const missingOrigin = await fetch(url, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    assert.equal(missingOrigin.status, 403);
    const foreignOrigin = await fetch(url, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify(patch),
    });
    assert.equal(foreignOrigin.status, 403);
    const illegal = await fetch(url, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ ...patch, registrationType: "PRIVATE_LIMITED", status: "ACTIVE" }),
    });
    assert.equal(illegal.status, 400);
    const correct = await fetch(url, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify(patch),
    });
    assert.equal(correct.status, 200);
    const result = await correct.json() as { success: boolean; version: number };
    assert.equal(result.success, true);
    assert.equal(result.version, 1);
    const audits = await rows(
      "SELECT COUNT(*) AS n FROM business_profile_edit_audits WHERE business_id = ?", [f.businessId]
    );
    assert.equal(Number(audits[0]?.n), 1);
    const business = await rows("SELECT name AS token, status FROM businesses WHERE id = ?", [f.businessId]);
    assert.equal(String(business[0]?.token), profileData.businessLegalName);
    assert.equal(String(business[0]?.status), "ACTIVE");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
