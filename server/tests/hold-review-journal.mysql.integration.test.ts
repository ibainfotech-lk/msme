import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  recordHoldReviewCandidate, HoldReviewJournalError,
  type RecordReviewCandidateInput,
} from "../src/modules/subscriptions/hold-review-journal.service";
import type { HoldLifecycleEvidence } from "../src/modules/subscriptions/subscription-hold-lifecycle.policy";
import {
  inspectStoredHoldNotice, HoldNoticeEvidenceError,
  type HoldNoticeQuery,
} from "../src/modules/subscriptions/hold-notice-evidence.service";
import type { MonthlyArrearsQuote } from "../src/modules/subscriptions/subscription-arrears.policy";

/* Destructive fixtures only on ephemeral GitHub Actions MySQL 8.4. */
const guarded =
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
if (!guarded) throw Error("STOP: Only ephemeral GitHub Actions MySQL 8.4 is permitted.");
process.env.NOTETO_HOLD_REVIEW_JOURNAL_ENABLED = "true";
process.env.NOTETO_HOLD_NOTICE_EVIDENCE_ENABLED = "true";

const db = mysql.createPool({
  host: "127.0.0.1", port: 3307, database: "noteto_dev",
  user: "noteto_services", password: "ci_dummy_unused_password",
  timezone: "Z", decimalNumbers: false, connectionLimit: 7,
});
after(async()=>{await db.end(); await runtimePool.end();});
const uid = () => randomUUID();
interface Row extends RowDataPacket {
  n?: number; token?: string; status?: string; held_at?: Date|null;
  review_id?: string;
}
async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await db.execute<Row[]>(sql,params);
  return result;
}
before(async()=>{
  assert.equal((await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"))[0]?.token,
    "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  assert.match(String((await rows("SELECT VERSION() AS token"))[0]?.token),/^8\.4\./);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"))[0]?.n),19);
  await db.execute(
    "INSERT INTO permissions (id, `key`, description) VALUES (?, 'billing.manage', 'CI') ON DUPLICATE KEY UPDATE `key` = `key`",
    [uid()]
  );
});
const asOf=new Date("2027-02-20T00:00:00.000Z");
const outstandingQuote: MonthlyArrearsQuote={
  currency:"LKR",asOf:asOf.toISOString(),completeThroughMonth:"2027-02-01",
  lines:[
    {billingMonth:"2027-01-01",chargeLkr:"499.00",waivedLkr:"0.00",verifiedPaidLkr:"0.00",outstandingLkr:"499.00"},
    {billingMonth:"2027-02-01",chargeLkr:"499.00",waivedLkr:"0.00",verifiedPaidLkr:"0.00",outstandingLkr:"499.00"},
  ],
  totalOutstandingLkr:"998.00",penaltyLkr:"0.00",paymentActionAllowed:false,
};
const settledQuote:MonthlyArrearsQuote={
  ...outstandingQuote,totalOutstandingLkr:"0.00",
  lines:outstandingQuote.lines.map(x=>({...x,verifiedPaidLkr:"499.00",outstandingLkr:"0.00"})),
};
interface Fixture { businessId:string; userId:string; subscriptionId:string; roleId:string }
async function fixture(status:"ACTIVE"|"PAST_DUE"="ACTIVE", allowBilling=true):Promise<Fixture>{
  const businessId=uid(),userId=uid(),subscriptionId=uid(),roleId=uid(),planId=uid();
  const connection=await db.getConnection();
  try{
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO users(id,phone,status,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [userId,"+9477"+String(Math.floor(Math.random()*1e7)).padStart(7,"0")]
    );
    await connection.execute(
      "INSERT INTO businesses(id,name,registration_type,status,updated_at) VALUES (?,'CI REVIEW','SOLE_PROPRIETOR','ACTIVE',UTC_TIMESTAMP(3))",
      [businessId]
    );
    await connection.execute(
      "INSERT INTO roles(id,business_id,name,is_system_role,updated_at) VALUES (?,?,'OWNER',1,UTC_TIMESTAMP(3))",
      [roleId,businessId]
    );
    if(allowBilling) await connection.execute(
      "INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE `key`='billing.manage'",
      [roleId]
    );
    await connection.execute(
      "INSERT INTO business_memberships(id,business_id,user_id,role_id,status,updated_at) VALUES (?,?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [uid(),businessId,userId,roleId]
    );
    await connection.execute(
      ["INSERT INTO subscription_plans",
       "(id,code,name,price_lkr,billing_interval,trial_days,invoice_limit,is_active,updated_at)",
       "VALUES (?,?,'CI REVIEW',499.00,'MONTHLY',0,30,1,UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_RV_"+uid().replace(/-/g,"").toUpperCase()]
    );
    await connection.execute(
      ["INSERT INTO business_subscriptions(id,business_id,plan_id,status,starts_at,held_at,updated_at)",
       "VALUES (?,?,?,?, '2026-10-01 00:00:00.000', ?, UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId,businessId,planId,status,status==="PAST_DUE"?"2027-02-16 00:00:00.000":null]
    );
    await connection.execute(
      "UPDATE businesses SET current_subscription_id=? WHERE id=?",
      [subscriptionId,businessId]
    );
    await connection.commit();
  }catch(e){await connection.rollback();throw e;}finally{connection.release();}
  return {businessId,userId,subscriptionId,roleId};
}
function input(f:Fixture,transition:"PLACE_HOLD"|"RESTORE_ACCESS"="PLACE_HOLD"):RecordReviewCandidateInput{
  const restoring=transition==="RESTORE_ACCESS";
  const evidence:HoldLifecycleEvidence={
    transition,businessStatus:"ACTIVE",currentSubscriptionStatus:restoring?"PAST_DUE":"ACTIVE",
    asOf,verifiedQuote:restoring?settledQuote:outstandingQuote,monthlyHistoryReviewed:true,
    verifiedPaymentHistoryReady:true,hasUnresolvedPaymentAttempts:false,hasDisputesOrChargebacks:false,
    trialOrPromotionEntitlementUnresolved:false,
    graceEndsAt:new Date("2027-02-15T00:00:00.000Z"),
    noticeDeliveredAt:new Date("2027-02-01T00:00:00.000Z"),
    noticeReference:"ci_review_notif_2027_02",
    heldAt:restoring?new Date("2027-02-16T00:00:00.000Z"):null,
    reviewApproved:true,reviewedBy:f.userId,
  };
  return {
    businessId:f.businessId,subscriptionId:f.subscriptionId,reviewerUserId:f.userId,
    idempotencyKey:"ci-review-"+uid(),reason:"Manual CI reviewed billing evidence",
    evidence,
  };
}
function code(expected:string){return (e:unknown):boolean=>{
  assert.ok(e instanceof HoldReviewJournalError);
  assert.equal(e.code,expected);return true;
};}
test("policy-ready hold candidate is journaled but subscription remains ACTIVE",async()=>{
  const f=await fixture();const result=await recordHoldReviewCandidate(input(f));
  assert.equal(result.status,"POLICY_READY");
  assert.equal(result.outstandingLkr,"998.00");
  assert.equal(result.subscriptionChanged,false);assert.equal(result.paymentInitiated,false);
  assert.equal((await rows("SELECT status FROM business_subscriptions WHERE id=?",[f.subscriptionId]))[0].status,"ACTIVE");
  assert.equal((await rows("SELECT held_at FROM business_subscriptions WHERE id=?",[f.subscriptionId]))[0].held_at,null);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM subscription_hold_review_journal WHERE business_id=?",[f.businessId]))[0].n),1);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id=?",[f.businessId]))[0].n),0);
});
test("restoration candidate leaves reviewed PAST_DUE hold in place",async()=>{
  const f=await fixture("PAST_DUE");const result=await recordHoldReviewCandidate(input(f,"RESTORE_ACCESS"));
  assert.equal(result.outstandingLkr,"0.00");
  assert.equal((await rows("SELECT status FROM business_subscriptions WHERE id=?",[f.subscriptionId]))[0].status,"PAST_DUE");
});
test("exact replay is idempotent; changed evidence with same key is rejected",async()=>{
  const f=await fixture(),request=input(f);
  const first=await recordHoldReviewCandidate(request);
  const again=await recordHoldReviewCandidate(request);
  assert.equal(again.reviewId,first.reviewId);assert.equal(again.replayed,true);
  await assert.rejects(
    ()=>recordHoldReviewCandidate({...request,reason:"Different audit reason requires a fresh key"}),
    code("REVIEW_IDEMPOTENCY_CONFLICT")
  );
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM subscription_hold_review_journal WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("unapproved policy or unpaid restoration cannot be journaled",async()=>{
  const f=await fixture();
  const request=input(f);
  await assert.rejects(()=>recordHoldReviewCandidate({
    ...request,evidence:{...request.evidence,reviewApproved:false},
  }),code("INVALID_REVIEW_CANDIDATE"));
  const held=await fixture("PAST_DUE");
  const attempt=input(held,"RESTORE_ACCESS");
  await assert.rejects(()=>recordHoldReviewCandidate({
    ...attempt,evidence:{...attempt.evidence,verifiedQuote:outstandingQuote},
  }),code("REVIEW_EVIDENCE_NOT_READY"));
});
test("same-tenant and current-subscription checks fail closed",async()=>{
  const f=await fixture(),other=await fixture();
  await assert.rejects(()=>recordHoldReviewCandidate({...input(f),subscriptionId:other.subscriptionId}),
    code("REVIEW_CURRENT_SUBSCRIPTION_MISMATCH"));
});
test("reviewer must hold current business billing permission",async()=>{
  const f=await fixture("ACTIVE",false);
  await assert.rejects(()=>recordHoldReviewCandidate(input(f)),code("REVIEWER_NOT_AUTHORIZED"));
});
test("concurrent identical candidates produce one journal row",async()=>{
  const f=await fixture(),request=input(f);
  const [first,second]=await Promise.all([
    recordHoldReviewCandidate(request),recordHoldReviewCandidate(request),
  ]);
  assert.equal(first.reviewId,second.reviewId);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM subscription_hold_review_journal WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("production and feature-disabled modes stop before opening a database",async()=>{
  const f=await fixture(),request=input(f);
  try{
    process.env.NOTETO_HOLD_REVIEW_JOURNAL_ENABLED="false";
    await assert.rejects(()=>recordHoldReviewCandidate(request,async()=>{throw Error("DB_CALLED");}),
      code("HOLD_REVIEW_JOURNAL_DISABLED"));
    process.env.NOTETO_HOLD_REVIEW_JOURNAL_ENABLED="true";
    process.env.NODE_ENV="production";
    await assert.rejects(()=>recordHoldReviewCandidate(request,async()=>{throw Error("DB_CALLED");}),
      code("HOLD_REVIEW_JOURNAL_DISABLED"));
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_HOLD_REVIEW_JOURNAL_ENABLED="true";
  }
});

const noticeAsOf = new Date("2026-11-22T00:00:00.000Z");
const statementHash = "a".repeat(64);
const termsVersion = "noteto-terms-1";
function noticeInput(f:Fixture):HoldNoticeQuery{
  return {
    businessId:f.businessId, subscriptionId:f.subscriptionId,
    reviewerUserId:f.userId, asOf:noticeAsOf,
    billingStatementSha256:statementHash, termsVersion,
  };
}
async function storeReceipt(
  f: Fixture,
  provenance:"UNVERIFIED"|"VERIFIED"="VERIFIED",
  graceEndsAt="2026-11-21 00:00:00.000"
) {
  const id=uid(), providerRef="ci-provider-"+uid();
  await db.execute([
    "INSERT INTO subscription_hold_notice_receipts",
    "(id,business_id,subscription_id,provider,delivery_channel,",
    "provider_delivery_reference,provider_event_sha256,notice_template_version,",
    "terms_version,billing_statement_sha256,delivered_at,verified_at,",
    "grace_ends_at,provenance_status)",
    "VALUES (?,?,?,'CI_SMS','SMS',? ,?, 'v1', ?,?,",
    "'2026-11-19 00:00:00.000', ?, ?, ?)",
  ].join(" "),[
    id,f.businessId,f.subscriptionId,providerRef,"d".repeat(64),
    termsVersion,statementHash,
    provenance==="VERIFIED"?"2026-11-20 00:00:00.000":null,
    graceEndsAt,provenance,
  ]);
  return {id,providerRef};
}

test("no provider delivery receipt means no hold authority",async()=>{
  const f=await fixture();
  const inspected=await inspectStoredHoldNotice(noticeInput(f));
  assert.equal(inspected.code,"NO_MATCHING_NOTICE");
  assert.equal(inspected.transitionAuthorized,false);
  assert.equal(inspected.subscriptionChanged,false);
});

test("recorded unverified provider receipt is rejected",async()=>{
  const f=await fixture();
  await storeReceipt(f,"UNVERIFIED");
  const result=await inspectStoredHoldNotice(noticeInput(f));
  assert.equal(result.code,"UNVERIFIED_PROVIDER_RECEIPT");
  assert.equal(result.transitionAuthorized,false);
});

test("matching stored proof and elapsed grace still cannot change a subscription",async()=>{
  const f=await fixture();
  const receipt=await storeReceipt(f);
  const result=await inspectStoredHoldNotice(noticeInput(f));
  assert.equal(result.code,"GRACE_DEADLINE_RECORDED");
  assert.equal(result.receiptId,receipt.id);
  assert.equal(result.transitionAuthorized,false);
  assert.equal(result.subscriptionChanged,false);
  assert.equal(result.paymentInitiated,false);
  assert.equal((await rows("SELECT status FROM business_subscriptions WHERE id=?",[f.subscriptionId]))[0]?.status,"ACTIVE");
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id=?",[f.businessId]))[0]?.n),0);
});

test("open grace window blocks notice review",async()=>{
  const f=await fixture();await storeReceipt(f,"VERIFIED","2026-11-25 00:00:00.000");
  assert.equal((await inspectStoredHoldNotice(noticeInput(f))).code,"GRACE_PERIOD_IN_PROGRESS");
});

test("tenant, monthly statement checksum and terms version are all binding",async()=>{
  const f=await fixture(),other=await fixture();
  await storeReceipt(f);
  assert.equal((await inspectStoredHoldNotice({
    ...noticeInput(f),billingStatementSha256:"b".repeat(64),
  })).code,"NO_MATCHING_NOTICE");
  assert.equal((await inspectStoredHoldNotice({
    ...noticeInput(f),termsVersion:"noteto-terms-2",
  })).code,"NO_MATCHING_NOTICE");
  await assert.rejects(()=>inspectStoredHoldNotice({
    ...noticeInput(f),reviewerUserId:other.userId,
  }),(e:unknown)=>{
    assert.ok(e instanceof HoldNoticeEvidenceError);
    assert.equal(e.code,"REVIEWER_PERMISSION_REQUIRED");return true;
  });
});

test("receipt provider reference cannot be reused",async()=>{
  const f=await fixture(),stored=await storeReceipt(f);
  await assert.rejects(()=>db.execute([
    "INSERT INTO subscription_hold_notice_receipts",
    "(id,business_id,subscription_id,provider,delivery_channel,",
    "provider_delivery_reference,provider_event_sha256,notice_template_version,",
    "terms_version,billing_statement_sha256,delivered_at,verified_at,grace_ends_at,provenance_status)",
    "VALUES (?,?,?,'CI_SMS','SMS',?,?,'v1',?,?,'2026-11-19 00:00:00.000',",
    "'2026-11-20 00:00:00.000','2026-11-21 00:00:00.000','VERIFIED')",
  ].join(" "),[
    uid(),f.businessId,f.subscriptionId,stored.providerRef,"e".repeat(64),
    termsVersion,statementHash,
  ]));
});

test("receipt delivered before subscription started is rejected",async()=>{
  const f=await fixture();
  await db.execute(
    "UPDATE business_subscriptions SET starts_at = '2026-11-20 00:00:00.000' WHERE id = ?",
    [f.subscriptionId]
  );
  await storeReceipt(f);
  const result=await inspectStoredHoldNotice(noticeInput(f));
  assert.equal(result.code,"INVALID_STORED_PROVENANCE");
  assert.equal(result.transitionAuthorized,false);
});

test("notice records cannot be used for already-held subscriptions",async()=>{
  const f=await fixture("PAST_DUE");
  await assert.rejects(()=>inspectStoredHoldNotice(noticeInput(f)),(e:unknown)=>{
    assert.ok(e instanceof HoldNoticeEvidenceError);
    assert.equal(e.code,"CURRENT_ACTIVE_SUBSCRIPTION_REQUIRED");return true;
  });
});

test("production or disabled notice inspection never opens MySQL",async()=>{
  const f=await fixture(),query=noticeInput(f);
  try{
    process.env.NOTETO_HOLD_NOTICE_EVIDENCE_ENABLED="false";
    await assert.rejects(()=>inspectStoredHoldNotice(query,async()=>{throw Error("DB_CALLED");}),
      (e:unknown)=>{assert.ok(e instanceof HoldNoticeEvidenceError);
        assert.equal(e.code,"HOLD_NOTICE_INSPECTION_DISABLED");return true;});
    process.env.NOTETO_HOLD_NOTICE_EVIDENCE_ENABLED="true";
    process.env.NODE_ENV="production";
    await assert.rejects(()=>inspectStoredHoldNotice(query,async()=>{throw Error("DB_CALLED");}),
      (e:unknown)=>{assert.ok(e instanceof HoldNoticeEvidenceError);
        assert.equal(e.code,"HOLD_NOTICE_INSPECTION_DISABLED");return true;});
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_HOLD_NOTICE_EVIDENCE_ENABLED="true";
  }
});
