import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after,before,test } from "node:test";
import express from "express";
import session from "express-session";
import mysql,{type RowDataPacket} from "mysql2/promise";
import runtimePool from "../src/config/database";
import taxRoutes from "../src/modules/taxes/tax-readiness.routes";
import { getTaxSourceCoverage } from "../src/modules/taxes/tax-rule-source-coverage.service";
import {saveTaxIntakeDraft,readTaxIntakeDraft,TaxIntakeError,type TaxIntakeClaims} from "../src/modules/taxes/taxpayer-intake-draft.service";
import { viewTaxReadiness,TaxReadinessError } from "../src/modules/taxes/tax-readiness.service";
import { createCashEntry } from "../src/modules/transactions/core-cashbook.service";
import { issueInvoice } from "../src/modules/invoices/invoice-issuance.service";

const ci=process.env.CI==="true"&&process.env.GITHUB_ACTIONS==="true"&&
  process.env.RUNNER_OS==="Linux"&&process.env.GITHUB_REPOSITORY==="ibainfotech-lk/msme"&&
  process.env.NODE_ENV==="development"&&
  process.env.NOTETO_CI_DISPOSABLE_DB==="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE"&&
  process.env.DB_HOST==="127.0.0.1"&&process.env.DB_PORT==="3307"&&
  process.env.DB_NAME==="noteto_dev"&&process.env.DB_USER==="noteto_services"&&
  process.env.DB_PASSWORD==="ci_dummy_unused_password";
if(!ci)throw Error("STOP: tax-readiness integration tests require disposable CI MySQL 8.4");
process.env.NOTETO_F17_TAX_READINESS_ENABLED="true";
process.env.NOTETO_F17_BOOKKEEPING_ENABLED="true";
process.env.NOTETO_F17_INVOICING_ENABLED="true";
process.env.NOTETO_F17_TAX_INTAKE_WRITE_ENABLED="true";
const db=mysql.createPool({
  host:"127.0.0.1",port:3307,user:"noteto_services",
  password:"ci_dummy_unused_password",database:"noteto_dev",timezone:"Z",
  decimalNumbers:false,connectionLimit:8,
});
const uid=()=>randomUUID();
interface Row extends RowDataPacket { n?:number; token?:string }
async function rows(sql:string,args:unknown[]=[]):Promise<Row[]>{
  const [r]=await db.execute<Row[]>(sql,args);return r;
}
after(async()=>{await db.end();await runtimePool.end();});
before(async()=>{
  assert.equal((await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"))[0]?.token,
    "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  assert.match(String((await rows("SELECT VERSION() AS token"))[0]?.token),/^8\.4\./);
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  ))[0]?.n), 25);
  for(const key of ["taxes.read","taxes.manage","transactions.create","invoices.create"]){
    await db.execute(
      "INSERT INTO permissions(id,`key`,description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `key`=`key`",
      [uid(),key,"F17.4 private tax preparation"]
    );
  }
});
type Kind="SOLE_PROPRIETOR"|"PRIVATE_LIMITED"|"COMMUNITY_ORGANIZATION";
interface Fixture{businessId:string;userId:string;subscriptionId:string;kind:Kind}
async function fixture(o:{
  kind?:Kind;status?:"ACTIVE"|"TRIALING"|"PAST_DUE";
  businessStatus?:"ACTIVE"|"SUSPENDED";expired?:boolean;
  permissions?:string[];
}={}):Promise<Fixture>{
  const businessId=uid(),userId=uid(),subscriptionId=uid(),planId=uid(),roleId=uid();
  const kind=o.kind??"SOLE_PROPRIETOR";
  const con=await db.getConnection();
  try{
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users(id,phone,status,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [userId,"+9477"+String(Math.floor(Math.random()*1e7)).padStart(7,"0")]
    );
    await con.execute(
      "INSERT INTO businesses(id,name,registration_type,status,updated_at) VALUES (?,'CI TAX READINESS',?,?,UTC_TIMESTAMP(3))",
      [businessId,kind,o.businessStatus??"ACTIVE"]
    );
    await con.execute(
      "INSERT INTO roles(id,business_id,name,is_system_role,updated_at) VALUES (?,?,'OWNER',1,UTC_TIMESTAMP(3))",
      [roleId,businessId]
    );
    for(const key of o.permissions??["taxes.read","transactions.create","invoices.create"]){
      await con.execute(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE `key`=?",
        [roleId,key]
      );
    }
    await con.execute(
      "INSERT INTO business_memberships(id,business_id,user_id,role_id,status,updated_at) VALUES (?,?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [uid(),businessId,userId,roleId]
    );
    await con.execute(
      ["INSERT INTO subscription_plans",
       "(id,code,name,price_lkr,billing_interval,trial_days,invoice_limit,is_active,updated_at)",
       "VALUES (?,?,'CI TAX',499.00,'MONTHLY',0,30,1,UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_TAX_"+uid().replace(/-/g,"").toUpperCase()]
    );
    await con.execute(
      ["INSERT INTO business_subscriptions",
       "(id,business_id,plan_id,status,starts_at,current_period_end,trial_ends_at,held_at,updated_at)",
       "VALUES (?,?,?,?,'2026-09-01 00:00:00.000',?,?,?,UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId,businessId,planId,o.status??"ACTIVE",
       o.expired?"2026-10-01 00:00:00.000":"2027-12-31 23:59:59.000",
       o.expired?"2026-10-01 00:00:00.000":"2027-12-31 23:59:59.000",
       o.status==="PAST_DUE"?"2026-11-01 00:00:00.000":null]
    );
    await con.execute(
      "UPDATE businesses SET current_subscription_id=? WHERE id=?",
      [subscriptionId,businessId]
    );
    await con.commit();
  }catch(e){await con.rollback();throw e;}finally{con.release();}
  return {businessId,userId,subscriptionId,kind};
}
async function cash(f:Fixture,type:"INCOME"|"EXPENSE",amountLkr:string,occurredOn:string){
  return createCashEntry({
    businessId:f.businessId,userId:f.userId,
    transactionType:type,amountLkr,occurredOn,category:"Trading",
    description:"Actual funds confirmed",cashConfirmed:true,
    idempotencyKey:"tax-test-cash-"+uid(),
  });
}
const query=(f:Fixture,assessmentYearStart=2026)=>viewTaxReadiness({
  businessId:f.businessId,userId:f.userId,assessmentYearStart,
});
function code(expected:string){
  return (e:unknown)=>{
    assert.ok(e instanceof TaxReadinessError);
    assert.equal(e.code,expected);return true;
  };
}
test("April–March YA uses only recorded cash surplus and never manufactures taxable income",async()=>{
  const f=await fixture();
  await cash(f,"INCOME","1000.55","2026-11-20");
  await cash(f,"EXPENSE","325.15","2026-11-20");
  const result=await query(f);
  assert.equal(result.assessmentYear,"2026/2027");
  assert.equal(result.assessmentStart,"2026-04-01");
  assert.equal(result.assessmentEnd,"2027-03-31");
  assert.equal(result.cashReceivedLkr,"1000.55");
  assert.equal(result.cashPaidLkr,"325.15");
  assert.equal(result.cashMovementSurplusLkr,"675.40");
  assert.equal(result.incomeEntries,1);
  assert.equal(result.expenseEntries,1);
  assert.equal(result.taxableIncomeLkr,null);
  assert.equal(result.taxPayableLkr,null);
  assert.equal(result.paymentDueLkr,null);
  assert.equal(result.taxRatePercent,null);
  assert.equal(result.personalReliefAppliedLkr,null);
  assert.equal(result.personalReliefEligibility,"UNVERIFIED");
  assert.equal(result.status,"REVIEW_REQUIRED");
  assert.equal(result.completeAssessmentYear,false);
  assert.equal(result.taxReturnOrPaymentAuthorized,false);
});
test("all registration types require tax review, not a shared tax threshold",async()=>{
  for(const kind of [
    "SOLE_PROPRIETOR","PRIVATE_LIMITED","COMMUNITY_ORGANIZATION",
  ] as const){
    const f=await fixture({kind});
    const r=await query(f);
    assert.equal(r.registrationType,kind);
    assert.equal(r.taxPayableLkr,null);
    assert.equal(r.requiresQualifiedSriLankanTaxReview,true);
  }
});
test("2025/2026 is April 2025–March 2026, not a calendar year",async()=>{
  const f=await fixture();
  await cash(f,"INCOME","100.00","2025-12-30");
  await cash(f,"INCOME","50.00","2026-04-01");
  const old=await query(f,2025),current=await query(f,2026);
  assert.equal(old.assessmentStart,"2025-04-01");
  assert.equal(old.assessmentEnd,"2026-03-31");
  assert.equal(old.cashReceivedLkr,"100.00");
  assert.equal(old.completeAssessmentYear,true);
  assert.equal(current.cashReceivedLkr,"50.00");
});
test("unpaid issued invoice is not a cash receipt or a tax liability",async()=>{
  const f=await fixture();
  await issueInvoice({
    businessId:f.businessId,userId:f.userId,
    customerName:"Unpaid business client",idempotencyKey:"tax-invoice-"+uid(),
    lines:[{description:"Products awaiting payment",quantity:"1.00",
      unitPriceLkr:"9999.00"}],
  });
  const r=await query(f);
  assert.equal(r.cashReceivedLkr,"0.00");
  assert.equal(r.cashMovementSurplusLkr,"0.00");
  assert.equal(r.invoicesWithoutVerifiedCashExcluded,true);
  assert.equal(r.taxPayableLkr,null);
});
test("cash spent can exceed cash received without negative tax payable inference",async()=>{
  const f=await fixture();
  await cash(f,"EXPENSE","500.00","2026-11-20");
  const r=await query(f);
  assert.equal(r.cashMovementSurplusLkr,"-500.00");
  assert.equal(r.taxPayableLkr,null);
});
test("tenant authorization and taxes.read are mandatory",async()=>{
  const a=await fixture(),b=await fixture();
  await assert.rejects(()=>viewTaxReadiness({
    businessId:b.businessId,userId:a.userId,assessmentYearStart:2026,
  }),code("TAX_PERMISSION_DENIED"));
  const noTax=await fixture({permissions:["transactions.create"]});
  await assert.rejects(()=>query(noTax),code("TAX_PERMISSION_DENIED"));
});
test("held, expired, suspended accounts cannot access live tax preparation",async()=>{
  for(const f of [
    await fixture({status:"PAST_DUE"}),
    await fixture({expired:true}),
    await fixture({businessStatus:"SUSPENDED"}),
  ]){
    await assert.rejects(()=>query(f),e=>{
      assert.ok(e instanceof TaxReadinessError);
      assert.ok(["TAX_SUBSCRIPTION_NOT_ELIGIBLE","TAX_BUSINESS_NOT_ACTIVE"].includes(e.code));
      return true;
    });
  }
});
test("a current TRIALING business can view tax preparation without tax payable",async()=>{
  const f=await fixture({status:"TRIALING"});
  const result=await query(f);
  assert.equal(result.status,"REVIEW_REQUIRED");
  assert.equal(result.taxPayableLkr,null);
});
test("invalid assessment year and future assessment fail before DB",async()=>{
  const f=await fixture();
  for(const value of [2024,2099,2026.5]){
    await assert.rejects(()=>viewTaxReadiness({
      businessId:f.businessId,userId:f.userId,assessmentYearStart:value,
    },async()=>{throw Error("UNEXPECTED_DB");}),code("INVALID_TAX_READINESS_REQUEST"));
  }
});
test("production and disabled feature reject before DB connection",async()=>{
  const f=await fixture();
  const request={businessId:f.businessId,userId:f.userId,assessmentYearStart:2026};
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(()=>viewTaxReadiness(request,async()=>{
      throw Error("UNEXPECTED_DB");
    }),code("TAX_READINESS_DISABLED"));
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_TAX_READINESS_ENABLED="false";
    await assert.rejects(()=>viewTaxReadiness(request,async()=>{
      throw Error("UNEXPECTED_DB");
    }),code("TAX_READINESS_DISABLED"));
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_TAX_READINESS_ENABLED="true";
  }
});
async function reviewSource(
  f:Fixture,
  status:"DRAFT"|"REVIEWED"|"REVOKED",
  options:{code?:string;scope?:"INDIVIDUAL"|"COMPANY"|"OTHER_ENTITY";
    year?:number;from?:string;to?:string;url?:string}={}
){
  const code=options.code??("CI_TAX_"+uid().replace(/-/g,""));
  const reviewer=status==="DRAFT"?null:f.userId;
  await db.execute(
    [
      "INSERT INTO tax_rule_source_reviews",
      "(id,source_code,revision,taxpayer_scope,assessment_year_start,",
      "effective_from,effective_to,source_title,source_uri,source_sha256,",
      "review_status,reviewed_by_user_id,reviewed_at,review_note)",
      "VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,",
      "IF(?='DRAFT',NULL,UTC_TIMESTAMP(3)), 'CI-only evidence')",
    ].join(" "),[
      uid(),code,options.scope??"INDIVIDUAL",options.year??2026,
      options.from??"2026-04-01",options.to??"2027-03-31",
      "IRD statutory source evidence - CI only",
      options.url??"https://www.ird.gov.lk/en/Type%20of%20Taxes/SitePages/Income%20Tax.aspx",
      "a".repeat(64),status,reviewer,status,
    ]
  );
}
test("legal evidence registry starts empty: no reviewed rules, no tax due",async()=>{
  const f=await fixture();
  const result=await getTaxSourceCoverage({
    businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  });
  // Shared catalog can contain rows from parallel suites; filter results
  // specifically based on fixtures created after this test if needed.
  assert.equal(result.taxPayableLkr,null);
  assert.equal(result.taxableIncomeLkr,null);
  assert.equal(result.taxCalculationEnabled,false);
  assert.equal(result.taxRatesReviewedForThisCustomer,false);
  assert.equal(result.taxpayerEligibilityConfirmed,false);
  assert.equal(result.rulesSeededAutomatically,false);
});
test("draft and revoked source records cannot masquerade as reviewed evidence",async()=>{
  const f=await fixture();
  const draftCode="DRAFT_"+uid().replace(/-/g,"");
  const revokedCode="REVOKED_"+uid().replace(/-/g,"");
  await reviewSource(f,"DRAFT",{code:draftCode});
  await reviewSource(f,"REVOKED",{code:revokedCode});
  const result=await getTaxSourceCoverage({
    businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  });
  assert.ok(!result.documents.some(x=>x.sourceCode===draftCode));
  assert.ok(!result.documents.some(x=>x.sourceCode===revokedCode));
  assert.equal(result.taxPayableLkr,null);
});
test("only reviewed and effective legal sources surface with provenance",async()=>{
  const f=await fixture();
  const reviewedCode="REVIEWED_"+uid().replace(/-/g,"");
  const oldCode="EXPIRED_"+uid().replace(/-/g,"");
  await reviewSource(f,"REVIEWED",{code:reviewedCode});
  await reviewSource(f,"REVIEWED",{
    code:oldCode,from:"2025-01-01",to:"2025-03-31",
  });
  const result=await getTaxSourceCoverage({
    businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  });
  const found=result.documents.find(x=>x.sourceCode===reviewedCode);
  assert.ok(found);
  assert.equal(found.revision,1);
  assert.equal(found.sourceSha256,"a".repeat(64));
  assert.equal(found.taxpayerScope,"INDIVIDUAL");
  assert.ok(!result.documents.some(x=>x.sourceCode===oldCode));
  assert.equal(result.legalSourceReviewAvailable,true);
  assert.equal(result.taxPayableLkr,null);
  assert.equal(result.reviewRequired,true);
});
test("MySQL 8.4 review timestamp CHECK still rejects approval without timestamp",async()=>{
  const f=await fixture(),sourceCode="NO_TIMESTAMP_"+uid().replace(/-/g,"");
  await reviewSource(f,"DRAFT",{code:sourceCode});
  await assert.rejects(()=>db.execute(
    "UPDATE tax_rule_source_reviews SET review_status='REVIEWED', reviewed_by_user_id=? WHERE source_code=?",
    [f.userId,sourceCode]
  ));
  const [state]=await db.execute<RowDataPacket[]>(
    "SELECT review_status,reviewed_at FROM tax_rule_source_reviews WHERE source_code=?",
    [sourceCode]
  );
  assert.equal(state[0]?.review_status,"DRAFT");
  assert.equal(state[0]?.reviewed_at,null);
});
test("missing reviewer on a REVIEWED source is rejected by read-side evidence gate",async()=>{
  const f=await fixture(),sourceCode="MISSING_REVIEWER_"+uid().replace(/-/g,"");
  await reviewSource(f,"REVIEWED",{code:sourceCode});
  // MySQL permits NULL in a nullable FK; the review workflow must never do
  // this, and the read-side gate must reject it rather than display approval.
  await db.execute(
    "UPDATE tax_rule_source_reviews SET reviewed_by_user_id=NULL WHERE source_code=?",
    [sourceCode]
  );
  try{
    await assert.rejects(()=>getTaxSourceCoverage({
      businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
    }),code("TAX_SOURCE_REVIEW_EVIDENCE_INVALID"));
  }finally{
    await db.execute(
      "UPDATE tax_rule_source_reviews SET review_status='REVOKED' WHERE source_code=?",
      [sourceCode]
    );
  }
});
test("untrusted or malformed reviewed source links fail closed",async()=>{
  const f=await fixture(),sourceCode="UNTRUSTED_"+uid().replace(/-/g,"");
  await reviewSource(f,"REVIEWED",{
    code:sourceCode,url:"https://example.com/tax-law",
  });
  try{
    await assert.rejects(()=>getTaxSourceCoverage({
      businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
    }),code("TAX_SOURCE_REVIEW_EVIDENCE_INVALID"));
  }finally{
    // CI-only disposable fixture cleanup; no customer records modified.
    await db.execute(
      "UPDATE tax_rule_source_reviews SET review_status='REVOKED' WHERE source_code=?",
      [sourceCode]
    );
  }
});
test("tax source coverage rejects unauthorized user, holds, production mode",async()=>{
  const f=await fixture({permissions:["transactions.create"]});
  await assert.rejects(()=>getTaxSourceCoverage({
    businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  }),code("TAX_PERMISSION_DENIED"));
  const held=await fixture({status:"PAST_DUE"});
  await assert.rejects(()=>getTaxSourceCoverage({
    businessId:held.businessId,userId:held.userId,assessmentYearStart:2026,
  }),code("TAX_SUBSCRIPTION_NOT_ELIGIBLE"));
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(()=>getTaxSourceCoverage({
      businessId:held.businessId,userId:held.userId,assessmentYearStart:2026,
    },async()=>{throw Error("DB_CALLED");}),code("TAX_READINESS_DISABLED"));
  }finally{process.env.NODE_ENV="development";}
});
const intakeClaims:TaxIntakeClaims={
  taxpayerCategoryClaim:"NOT_SURE",residencyClaim:"UNKNOWN",
  otherIncomeClaim:"YES",capitalAssetsClaim:"YES",
  nonDeductibleCostsClaim:"NOT_SURE",withholdingCreditsClaim:"UNKNOWN",
  ownerIsTaxpayerClaim:"NOT_SURE",
};
const taxInput=(f:Fixture,expectedRevision:number|null=null)=>({
  businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  expectedRevision,claims:intakeClaims,
});
test("intake is absent by default, without personal tax IDs, and never computes tax due",async()=>{
  const f=await fixture();
  const intake=await readTaxIntakeDraft({
    businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  });
  assert.equal(intake.status,"NOT_STARTED");
  assert.equal(intake.revision,null);
  assert.equal(intake.taxPayableLkr,null);
  assert.equal(intake.taxableIncomeLkr,null);
  assert.equal(intake.legalOrTaxProfessionalVerified,false);
});
test("authorized preparation draft creates one audited revision and remains UNVERIFIED",async()=>{
  const f=await fixture({permissions:["taxes.read","taxes.manage"]});
  const draft=await saveTaxIntakeDraft(taxInput(f));
  assert.equal(draft.status,"UNVERIFIED_DRAFT");
  assert.equal(draft.revision,1);
  assert.equal(draft.taxPayableLkr,null);
  assert.equal(draft.legalOrTaxProfessionalVerified,false);
  assert.equal(draft.claims?.capitalAssetsClaim,"YES");
  const read=await readTaxIntakeDraft({
    businessId:f.businessId,userId:f.userId,assessmentYearStart:2026,
  });
  assert.deepEqual(read.claims,intakeClaims);
  const counts=await rows(
    "SELECT COUNT(*) AS n FROM taxpayer_intake_draft_audits WHERE business_id=?",
    [f.businessId]
  );
  assert.equal(Number(counts[0]?.n),1);
});
test("updating a draft increments optimistic revision and preserves before/after audit",async()=>{
  const f=await fixture({permissions:["taxes.read","taxes.manage"]});
  const first=await saveTaxIntakeDraft(taxInput(f));
  assert.equal(first.revision,1);
  const modified={
    ...taxInput(f,1),claims:{...intakeClaims,residencyClaim:"RESIDENT" as const},
  };
  const next=await saveTaxIntakeDraft(modified);
  assert.equal(next.revision,2);
  assert.equal(next.claims?.residencyClaim,"RESIDENT");
  await assert.rejects(()=>saveTaxIntakeDraft(taxInput(f,1)),(e:unknown)=>{
    assert.ok(e instanceof TaxIntakeError);
    assert.equal(e.code,"TAX_INTAKE_REVISION_CONFLICT");return true;
  });
  const audit=await rows(
    "SELECT COUNT(*) AS n FROM taxpayer_intake_draft_audits WHERE business_id=?",
    [f.businessId]
  );
  assert.equal(Number(audit[0]?.n),2);
  const [revisions]=await db.execute<RowDataPacket[]>(
    "SELECT previous_claims_json,updated_claims_json FROM taxpayer_intake_draft_audits WHERE business_id=? AND revision=2",
    [f.businessId]
  );
  const before=typeof revisions[0]?.previous_claims_json==="string"
    ?JSON.parse(revisions[0].previous_claims_json):revisions[0]?.previous_claims_json;
  const after=typeof revisions[0]?.updated_claims_json==="string"
    ?JSON.parse(revisions[0].updated_claims_json):revisions[0]?.updated_claims_json;
  assert.equal(before.residencyClaim,"UNKNOWN");
  assert.equal(after.residencyClaim,"RESIDENT");
});
test("two concurrent first-draft saves create exactly one audited draft",async()=>{
  const f=await fixture({permissions:["taxes.read","taxes.manage"]});
  const outcomes=await Promise.allSettled([
    saveTaxIntakeDraft(taxInput(f)),saveTaxIntakeDraft(taxInput(f)),
  ]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(outcomes.filter(x=>x.status==="rejected").length,1);
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM taxpayer_intake_drafts WHERE business_id=?",
    [f.businessId]
  ))[0]?.n),1);
  assert.equal(Number((await rows(
    "SELECT COUNT(*) AS n FROM taxpayer_intake_draft_audits WHERE business_id=?",
    [f.businessId]
  ))[0]?.n),1);
});
test("cross tenant and missing taxes.manage both deny draft writes",async()=>{
  const a=await fixture({permissions:["taxes.read","taxes.manage"]});
  const b=await fixture();
  await assert.rejects(()=>saveTaxIntakeDraft({
    ...taxInput(a),userId:b.userId,
  }),(e:unknown)=>{
    assert.ok(e instanceof TaxReadinessError);
    assert.equal(e.code,"TAX_PERMISSION_DENIED");return true;
  });
  await assert.rejects(()=>saveTaxIntakeDraft(taxInput(b)),(e:unknown)=>{
    assert.ok(e instanceof TaxIntakeError);
    assert.equal(e.code,"TAX_INTAKE_MANAGE_PERMISSION_DENIED");return true;
  });
});
test("held account cannot read or write tax questionnaire",async()=>{
  const held=await fixture({status:"PAST_DUE",
    permissions:["taxes.read","taxes.manage"]});
  await assert.rejects(()=>saveTaxIntakeDraft(taxInput(held)),(e:unknown)=>{
    assert.ok(e instanceof TaxReadinessError);
    assert.equal(e.code,"TAX_SUBSCRIPTION_NOT_ELIGIBLE");return true;
  });
  await assert.rejects(()=>readTaxIntakeDraft({
    businessId:held.businessId,userId:held.userId,assessmentYearStart:2026,
  }),(e:unknown)=>{
    assert.ok(e instanceof TaxReadinessError);
    assert.equal(e.code,"TAX_SUBSCRIPTION_NOT_ELIGIBLE");return true;
  });
});
test("unverified claim validation rejects extra PII and unrecognized status before DB",async()=>{
  const f=await fixture({permissions:["taxes.read","taxes.manage"]});
  for(const input of [
    {...taxInput(f),claims:{...intakeClaims,tin:"012345678"}},
    {...taxInput(f),claims:{...intakeClaims,residencyClaim:"VERIFIED"}},
    {...taxInput(f),expectedRevision:-1},
  ]){
    await assert.rejects(()=>saveTaxIntakeDraft(input as typeof input & {
      claims:TaxIntakeClaims,
    },async()=>{throw Error("DB_CALLED");}),(e:unknown)=>{
      assert.ok(e instanceof TaxIntakeError);
      assert.ok(["INVALID_TAX_INTAKE_CLAIMS","INVALID_TAX_INTAKE_REVISION"].includes(e.code));
      return true;
    });
  }
});
test("tax intake write disabled in production and without opt-in, prior to DB access",async()=>{
  const f=await fixture({permissions:["taxes.read","taxes.manage"]});
  const input=taxInput(f);
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(()=>saveTaxIntakeDraft(input,async()=>{
      throw Error("DB_CALLED");
    }),(e:unknown)=>{
      assert.ok(e instanceof TaxIntakeError);
      assert.equal(e.code,"TAX_INTAKE_WRITE_DISABLED");return true;
    });
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_TAX_INTAKE_WRITE_ENABLED="false";
    await assert.rejects(()=>saveTaxIntakeDraft(input,async()=>{
      throw Error("DB_CALLED");
    }),(e:unknown)=>{
      assert.ok(e instanceof TaxIntakeError);
      assert.equal(e.code,"TAX_INTAKE_WRITE_DISABLED");return true;
    });
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_TAX_INTAKE_WRITE_ENABLED="true";
  }
});
test("HTTP endpoint requires auth, strict query, tenant rights and guarded intake PUT",async()=>{
  const f=await fixture({permissions:["taxes.read","taxes.manage"]}),other=await fixture(),nonce=uid();
  const app=express();
  app.use(express.json({limit:"20kb"}));
  app.use(session({
    secret:"noteto-tax-ci-only-long-test-session-secret",
    resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax"},
  }));
  app.post("/__ci/login",(req,res,next)=>{
    if(req.get("X-CI-Nonce")!==nonce){res.sendStatus(403);return;}
    req.session.userId=f.userId;
    req.session.save(e=>e?next(e):res.json({success:true}));
  });
  app.use("/api/taxes",taxRoutes);
  const server=createServer(app);
  try{
    await new Promise<void>((resolve,reject)=>{
      server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
    });
    const base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
    const url=base+"/api/taxes/businesses/"+f.businessId+
      "/readiness?assessmentYearStart=2026";
    assert.equal((await fetch(url)).status,401);
    const login=await fetch(base+"/__ci/login",{
      method:"POST",headers:{"X-CI-Nonce":nonce},
    });
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const response=await fetch(url,{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const body=await response.json() as {
      readiness:{status:string;taxPayableLkr:string|null};
    };
    assert.equal(body.readiness.status,"REVIEW_REQUIRED");
    assert.equal(body.readiness.taxPayableLkr,null);
    assert.equal((await fetch(url+"&taxRate=0",{headers:{Cookie:cookie}})).status,400);
    assert.equal((await fetch(url.replace(f.businessId,other.businessId),{
      headers:{Cookie:cookie},
    })).status,403);
    const sourcesUrl=base+"/api/taxes/businesses/"+f.businessId+
      "/sources?assessmentYearStart=2026";
    const coverageResponse=await fetch(sourcesUrl,{headers:{Cookie:cookie}});
    assert.equal(coverageResponse.status,200);
    const coverageData=await coverageResponse.json() as {
      coverage:{taxPayableLkr:null;taxCalculationEnabled:false};
    };
    assert.equal(coverageData.coverage.taxPayableLkr,null);
    assert.equal(coverageData.coverage.taxCalculationEnabled,false);
    assert.equal((await fetch(sourcesUrl+"&rate=0",{
      headers:{Cookie:cookie},
    })).status,400);
    assert.equal((await fetch(sourcesUrl,{method:"POST",headers:{Cookie:cookie}})).status,405);
    const checklistUrl=base+"/api/taxes/businesses/"+f.businessId+
      "/review-checklist?assessmentYearStart=2026";
    assert.equal((await fetch(checklistUrl)).status,401);
    const checklistBefore=await fetch(checklistUrl,{headers:{Cookie:cookie}});
    assert.equal(checklistBefore.status,200);
    const checklistEmpty=await checklistBefore.json() as {
      checklist:{answersMissing:number;taxPayableLkr:null;taxCalculationEnabled:false};
    };
    assert.equal(checklistEmpty.checklist.answersMissing,7);
    assert.equal(checklistEmpty.checklist.taxPayableLkr,null);
    assert.equal(checklistEmpty.checklist.taxCalculationEnabled,false);
    assert.equal((await fetch(checklistUrl+"&rate=15",{headers:{Cookie:cookie}})).status,400);
    assert.equal((await fetch(checklistUrl.replace(f.businessId,other.businessId),{
      headers:{Cookie:cookie},
    })).status,403);
    assert.equal((await fetch(checklistUrl,{method:"POST",headers:{Cookie:cookie}})).status,405);
    const intakeUrl=base+"/api/taxes/businesses/"+f.businessId+
      "/intake?assessmentYearStart=2026";
    assert.equal((await fetch(intakeUrl)).status,401);
    const intakeRead=await fetch(intakeUrl,{headers:{Cookie:cookie}});
    assert.equal(intakeRead.status,200);
    const readBody=await intakeRead.json() as {intake:{status:string;taxPayableLkr:null}};
    assert.equal(readBody.intake.status,"NOT_STARTED");
    assert.equal(readBody.intake.taxPayableLkr,null);
    const intakeSaveUrl=intakeUrl.split("?")[0];
    const payload={assessmentYearStart:2026,expectedRevision:null,claims:intakeClaims};
    assert.equal((await fetch(intakeSaveUrl,{
      method:"PUT",headers:{Cookie:cookie,"Content-Type":"application/json"},
      body:JSON.stringify(payload),
    })).status,403);
    assert.equal((await fetch(intakeSaveUrl,{
      method:"PUT",headers:{Cookie:cookie,Origin:"http://localhost:5173",
        "Content-Type":"application/json"},
      body:JSON.stringify({...payload,tin:"unacceptable"}),
    })).status,400);
    const saved=await fetch(intakeSaveUrl,{
      method:"PUT",headers:{Cookie:cookie,Origin:"http://localhost:5173",
        "Content-Type":"application/json"},
      body:JSON.stringify(payload),
    });
    assert.equal(saved.status,200);
    const savedBody=await saved.json() as {intake:{revision:number;status:string}};
    assert.equal(savedBody.intake.revision,1);
    assert.equal(savedBody.intake.status,"UNVERIFIED_DRAFT");
    const checklistAfter=await fetch(checklistUrl,{headers:{Cookie:cookie}});
    assert.equal(checklistAfter.status,200);
    const checklistSaved=await checklistAfter.json() as {
      checklist:{answersProvided:number;answersMissing:number;
        allDeclarationsVerified:false;taxPayableLkr:null;draftRevision:number};
    };
    assert.equal(checklistSaved.checklist.answersProvided,2);
    assert.equal(checklistSaved.checklist.answersMissing,5);
    assert.equal(checklistSaved.checklist.allDeclarationsVerified,false);
    assert.equal(checklistSaved.checklist.taxPayableLkr,null);
    assert.equal(checklistSaved.checklist.draftRevision,1);
    assert.equal((await fetch(intakeSaveUrl,{
      method:"PUT",headers:{Cookie:cookie,Origin:"http://localhost:5173",
        "Content-Type":"application/json"},
      body:JSON.stringify(payload),
    })).status,409);
    assert.equal((await fetch(intakeRead.url.replace(f.businessId,other.businessId),{
      headers:{Cookie:cookie},
    })).status,403);
    assert.equal((await fetch(intakeSaveUrl,{method:"POST",headers:{Cookie:cookie}})).status,405);
    assert.equal((await fetch(url,{method:"POST",headers:{Cookie:cookie}})).status,405);
    try{
      process.env.NODE_ENV="production";
      assert.equal((await fetch(url,{headers:{Cookie:cookie}})).status,503);
    }finally{process.env.NODE_ENV="development";}
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
