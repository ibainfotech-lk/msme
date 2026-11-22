import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  loadPreviouslyGeneratedPdf, ArchivedReportError,
} from "../src/modules/reports/archived-report-download.service";

/* DESTRUCTIVE FIXTURE GUARD: disposable GitHub Actions MySQL 8.4 ONLY. */
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
if (!allowed) throw Error("STOP: Report archives CI requires disposable MySQL 8.4 only.");

process.env.NOTETO_ARCHIVED_REPORT_DOWNLOAD_ENABLED = "true";
const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, database: "noteto_dev",
  user: "noteto_services", password: "ci_dummy_unused_password",
  timezone: "Z", decimalNumbers: false, connectionLimit: 5,
});
after(async () => { await db.end(); await runtimePool.end(); });
interface Row extends RowDataPacket { n?: number; token?: string }
async function rows(sql: string, values: unknown[] = []): Promise<Row[]> {
  const [r] = await db.execute<Row[]>(sql, values);
  return r;
}
const uid = () => randomUUID();
const pdf = Buffer.from("%PDF-1.4\n% Noteto archived snapshot CI\n%%EOF");
const digest = createHash("sha256").update(pdf).digest("hex");

before(async () => {
  const marker = await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(marker[0]?.token, "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const versions = await rows("SELECT VERSION() AS version, DATABASE() AS database_name");
  assert.match(String(versions[0]?.version), /^8\.4\./);
  assert.equal(versions[0]?.database_name, "noteto_dev");
  const migrations = await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL");
  assert.equal(Number(migrations[0]?.n), 18);
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'reports.read', 'CI') ON DUPLICATE KEY UPDATE `key` = `key`",
    [uid()]
  );
});
interface Fixture { businessId: string; userId: string; subscriptionId: string; reportId: string }
async function fixture(options: {
  subscriptionStatus?: "ACTIVE" | "PAST_DUE" | "CANCELLED";
  heldAt?: string | null;
  reportGeneratedAt?: string;
  checksum?: string;
} = {}): Promise<Fixture> {
  const businessId=uid(),userId=uid(),roleId=uid(),planId=uid(),subscriptionId=uid(),reportId=uid();
  const con=await db.getConnection();
  try {
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users (id, phone, status, updated_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [userId, "+9477" + String(Math.floor(Math.random() * 10000000)).padStart(7, "0")]
    );
    await con.execute(
      "INSERT INTO businesses (id, name, registration_type, status, updated_at) VALUES (?, 'CI PDF ARCHIVE', 'SOLE_PROPRIETOR', 'ACTIVE', UTC_TIMESTAMP(3))",
      [businessId]
    );
    await con.execute(
      "INSERT INTO roles (id, business_id, name, is_system_role, updated_at) VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))",
      [roleId,businessId]
    );
    await con.execute(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE `key` = 'reports.read'",
      [roleId]
    );
    await con.execute(
      "INSERT INTO business_memberships (id, business_id, user_id, role_id, status, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      [uid(),businessId,userId,roleId]
    );
    await con.execute(
      ["INSERT INTO subscription_plans",
       "(id, code, name, price_lkr, billing_interval, trial_days, invoice_limit, is_active, updated_at)",
       "VALUES (?, ?, 'CI ARCHIVE', 499.00, 'MONTHLY', 0, 30, 1, UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_PDF_"+uid().replace(/-/g,"").toUpperCase()]
    );
    await con.execute(
      ["INSERT INTO business_subscriptions",
       "(id, business_id, plan_id, status, starts_at, held_at, updated_at)",
       "VALUES (?, ?, ?, ?, '2026-09-01 00:00:00.000', ?, UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId,businessId,planId,options.subscriptionStatus ?? "PAST_DUE",
       options.heldAt === undefined ? "2026-11-01 00:00:00.000" : options.heldAt]
    );
    await con.execute("UPDATE businesses SET current_subscription_id = ? WHERE id = ?",
      [subscriptionId,businessId]);
    await con.execute(
      ["INSERT INTO archived_report_snapshots",
       "(id, business_id, subscription_id, generated_by_user_id, report_type,",
       "period_start, period_end, content_type, content_sha256, content_length, pdf_bytes, generated_at)",
       "VALUES (?, ?, ?, ?, 'YEARLY', '2026-10-01', '2026-10-31', 'application/pdf', ?, ?, ?, ?)"].join(" "),
      [reportId,businessId,subscriptionId,userId,options.checksum ?? digest,pdf.length,pdf,
       options.reportGeneratedAt ?? "2026-10-31 12:00:00.000"]
    );
    await con.commit();
  } catch (e) {
    await con.rollback();
    throw e;
  } finally {
    con.release();
  }
  return {businessId,userId,subscriptionId,reportId};
}
const ref = (f:Fixture)=>({businessId:f.businessId,userId:f.userId,reportId:f.reportId});
function code(expected:string){
  return (error:unknown):boolean=>{
    assert.ok(error instanceof ArchivedReportError);
    assert.equal(error.code,expected);
    return true;
  };
}
test("held customer can retrieve only an existing unchanged PDF from before the hold",async()=>{
  const f=await fixture();
  const got=await loadPreviouslyGeneratedPdf(ref(f));
  assert.equal(got.contentType,"application/pdf");
  assert.equal(got.checksumSha256,digest);
  assert.ok(got.bytes.equals(pdf));
  assert.equal(got.generatedAt.toISOString(),"2026-10-31T12:00:00.000Z");
  const count=await rows("SELECT COUNT(*) AS n FROM archived_report_snapshots WHERE business_id = ?",[f.businessId]);
  assert.equal(Number(count[0]?.n),1);
});
test("report created after hold is denied",async()=>{
  const f=await fixture({reportGeneratedAt:"2026-11-02 12:00:00.000"});
  await assert.rejects(()=>loadPreviouslyGeneratedPdf(ref(f)),code("RESOURCE_PROOF_REQUIRED"));
});
test("past-due subscription without reliable hold timestamp fails closed",async()=>{
  const f=await fixture({heldAt:null});
  await assert.rejects(()=>loadPreviouslyGeneratedPdf(ref(f)),code("RESOURCE_PROOF_REQUIRED"));
});
test("full active subscription can retrieve previously generated intact archived report",async()=>{
  const f=await fixture({subscriptionStatus:"ACTIVE",heldAt:null});
  assert.equal((await loadPreviouslyGeneratedPdf(ref(f))).checksumSha256,digest);
});
test("cancelled subscription cannot download reports",async()=>{
  const f=await fixture({subscriptionStatus:"CANCELLED"});
  await assert.rejects(()=>loadPreviouslyGeneratedPdf(ref(f)),code("SUBSCRIPTION_ACCESS_LOCKED"));
});
test("reports from another tenant must never be returned",async()=>{
  const a=await fixture(),b=await fixture();
  await assert.rejects(()=>loadPreviouslyGeneratedPdf({...ref(a),reportId:b.reportId}),code("ARCHIVED_REPORT_NOT_FOUND"));
});
test("tampered checksum fails integrity verification",async()=>{
  const f=await fixture({checksum:"0".repeat(64)});
  await assert.rejects(()=>loadPreviouslyGeneratedPdf(ref(f)),code("ARCHIVED_REPORT_INTEGRITY_FAILED"));
});
test("download rejects changed archive bytes when the recorded checksum is unchanged",async()=>{
  const f=await fixture();
  const tampered=Buffer.from(pdf);
  tampered[tampered.length - 1] = tampered[tampered.length - 1] === 70 ? 71 : 70;
  // CI's migration account has write access; SQL immutability is not
  // guaranteed without a separately configured least-privilege account.
  await db.execute(
    "UPDATE archived_report_snapshots SET pdf_bytes = ? WHERE id = ?",
    [tampered,f.reportId]
  );
  await assert.rejects(
    ()=>loadPreviouslyGeneratedPdf(ref(f)),
    code("ARCHIVED_REPORT_INTEGRITY_FAILED")
  );
});
test("production guard rejects before contacting database",async()=>{
  const f=await fixture();
  try {
    process.env.NODE_ENV="production";
    await assert.rejects(
      ()=>loadPreviouslyGeneratedPdf(ref(f),async()=>{throw Error("UNEXPECTED_DB");}),
      code("ARCHIVED_REPORT_DOWNLOAD_DISABLED")
    );
  } finally {process.env.NODE_ENV="development";}
});
