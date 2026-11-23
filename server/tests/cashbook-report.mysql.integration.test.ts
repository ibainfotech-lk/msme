import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import session from "express-session";
import mysql,{type RowDataPacket} from "mysql2/promise";
import runtimePool from "../src/config/database";
import reportRoutes from "../src/modules/reports/report.routes";
import {
  previewCashbookReport,CashbookReportError,
  type CashbookReportPeriod,
} from "../src/modules/reports/cashbook-report.service";
import { createCashEntry, updateActiveCashEntry } from "../src/modules/transactions/core-cashbook.service";
import { issueInvoice } from "../src/modules/invoices/invoice-issuance.service";

const guard=process.env.CI==="true" && process.env.GITHUB_ACTIONS==="true" &&
  process.env.RUNNER_OS==="Linux" &&
  process.env.GITHUB_REPOSITORY==="ibainfotech-lk/msme" &&
  process.env.NODE_ENV==="development" &&
  process.env.NOTETO_CI_DISPOSABLE_DB==="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
  process.env.DB_HOST==="127.0.0.1" && process.env.DB_PORT==="3307" &&
  process.env.DB_NAME==="noteto_dev" && process.env.DB_USER==="noteto_services" &&
  process.env.DB_PASSWORD==="ci_dummy_unused_password";
if(!guard) throw Error("STOP: F17.3 requires disposable GitHub MySQL 8.4");
process.env.NOTETO_F17_REPORT_PREVIEW_ENABLED="true";
process.env.NOTETO_F17_BOOKKEEPING_ENABLED="true";
process.env.NOTETO_F17_INVOICING_ENABLED="true";
const db=mysql.createPool({
  host:"127.0.0.1",port:3307,database:"noteto_dev",user:"noteto_services",
  password:"ci_dummy_unused_password",timezone:"Z",decimalNumbers:false,connectionLimit:8,
});
const uid=()=>randomUUID();
interface Row extends RowDataPacket {n?:number;token?:string;}
async function rows(sql:string,params:unknown[]=[]):Promise<Row[]>{
  const [result]=await db.execute<Row[]>(sql,params);return result;
}
after(async()=>{await db.end();await runtimePool.end();});
before(async()=>{
  assert.equal((await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"))[0]?.token,
    "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  assert.match(String((await rows("SELECT VERSION() AS token"))[0]?.token),/^8\.4\./);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"))[0]?.n),21);
  for(const key of ["reports.generate","transactions.create","transactions.update","invoices.create"]){
    await db.execute(
      "INSERT INTO permissions(id,`key`,description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `key`=`key`",
      [uid(),key,"F17.3 disposable reports"]
    );
  }
});
interface Fixture{businessId:string;userId:string;subscriptionId:string}
async function fixture(options:{
  status?:"ACTIVE"|"TRIALING"|"PAST_DUE";
  businessStatus?:"ACTIVE"|"SUSPENDED";
  permissions?:string[];
  expired?:boolean;
}={}):Promise<Fixture>{
  const businessId=uid(),userId=uid(),subscriptionId=uid(),roleId=uid(),planId=uid();
  const con=await db.getConnection();
  try{
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users(id,phone,status,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [userId,"+9477"+String(Math.floor(Math.random()*1e7)).padStart(7,"0")]
    );
    await con.execute(
      "INSERT INTO businesses(id,name,registration_type,status,updated_at) VALUES (?,'CI REPORT','SOLE_PROPRIETOR',?,UTC_TIMESTAMP(3))",
      [businessId,options.businessStatus??"ACTIVE"]
    );
    await con.execute(
      "INSERT INTO roles(id,business_id,name,is_system_role,updated_at) VALUES (?,?,'OWNER',1,UTC_TIMESTAMP(3))",
      [roleId,businessId]
    );
    for(const key of options.permissions??[
      "reports.generate","transactions.create","transactions.update","invoices.create"
    ]){
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
       "VALUES (?,?,'CI REPORTS',499.00,'MONTHLY',0,30,1,UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_REPORT_"+uid().replace(/-/g,"").toUpperCase()]
    );
    await con.execute(
      ["INSERT INTO business_subscriptions",
       "(id,business_id,plan_id,status,starts_at,current_period_end,trial_ends_at,held_at,updated_at)",
       "VALUES (?,?,?,?,'2026-09-01 00:00:00.000',?,?,?,UTC_TIMESTAMP(3))"].join(" "),
      [subscriptionId,businessId,planId,options.status??"ACTIVE",
       options.expired?"2026-10-01 00:00:00.000":"2027-12-31 23:59:59.000",
       options.expired?"2026-10-01 00:00:00.000":"2027-12-31 23:59:59.000",
       options.status==="PAST_DUE"?"2026-11-01 00:00:00.000":null]
    );
    await con.execute("UPDATE businesses SET current_subscription_id=? WHERE id=?",
      [subscriptionId,businessId]);
    await con.commit();
  }catch(e){await con.rollback();throw e;}finally{con.release();}
  return {businessId,userId,subscriptionId};
}
async function cash(
  f:Fixture,type:"INCOME"|"EXPENSE",amountLkr:string,occurredOn:string,
  category="Sales"
):Promise<string>{
  const created=await createCashEntry({
    businessId:f.businessId,userId:f.userId,transactionType:type,
    amountLkr,occurredOn,category,description:"Confirmed cash movement",
    cashConfirmed:true,idempotencyKey:"report-cash-"+uid(),
  });
  return created.transactionId;
}
function report(f:Fixture,period:CashbookReportPeriod,periodKey:string){
  return previewCashbookReport({businessId:f.businessId,userId:f.userId,period,periodKey});
}
function error(expected:string){
  return (e:unknown):boolean=>{
    assert.ok(e instanceof CashbookReportError);assert.equal(e.code,expected);return true;
  };
}
test("daily report uses only confirmed cash entries and exact cents",async()=>{
  const f=await fixture();
  await cash(f,"INCOME","250.25","2026-11-20","Sales");
  await cash(f,"INCOME","100.10","2026-11-20","Sales");
  await cash(f,"EXPENSE","50.05","2026-11-20","Transport");
  await cash(f,"INCOME","700.00","2026-11-19","Sales");
  const r=await report(f,"DAILY","2026-11-20");
  assert.equal(r.totals.cashInLkr,"350.35");
  assert.equal(r.totals.cashOutLkr,"50.05");
  assert.equal(r.totals.netMovementLkr,"300.30");
  assert.equal(r.totals.incomeEntries,2);
  assert.equal(r.totals.expenseEntries,1);
  assert.equal(r.dailyBreakdown.length,1);
  assert.equal(r.reportSnapshotSaved,false);
  assert.equal(r.invoiceAmountsIncluded,false);
  assert.equal(r.reconciledOpeningBalanceAvailable,false);
});
test("one-week report begins Monday and includes zero-activity days",async()=>{
  const f=await fixture();
  await cash(f,"INCOME","120.00","2026-11-16");
  await cash(f,"EXPENSE","220.20","2026-11-22","Rent");
  await cash(f,"INCOME","900.00","2026-11-23");
  const r=await report(f,"WEEKLY","2026-11-16");
  assert.equal(r.periodEnd,"2026-11-22");
  assert.equal(r.dailyBreakdown.length,7);
  assert.equal(r.totals.netMovementLkr,"-100.20");
  assert.equal(r.dailyBreakdown[1].cashInLkr,"0.00");
  assert.equal(r.dailyBreakdown[6].cashOutLkr,"220.20");
});
test("yearly report splits months and category totals without calculating tax",async()=>{
  const f=await fixture();
  await cash(f,"INCOME","500.00","2026-09-25","Sales");
  await cash(f,"EXPENSE","200.00","2026-10-06","Utilities");
  await cash(f,"INCOME","50.00","2026-11-20","Sales");
  const r=await report(f,"YEARLY","2026");
  assert.equal(r.periodStart,"2026-01-01");
  assert.equal(r.periodEnd,"2026-12-31");
  assert.equal(r.monthlyBreakdown.length,12);
  assert.equal(r.monthlyBreakdown[8].cashInLkr,"500.00");
  assert.equal(r.monthlyBreakdown[9].cashOutLkr,"200.00");
  assert.equal(r.monthlyBreakdown[10].cashInLkr,"50.00");
  assert.equal(r.totals.netMovementLkr,"350.00");
  assert.equal(r.categoryBreakdown.find(x=>x.category==="Sales")?.totalLkr,"550.00");
  assert.equal(r.cashbookOnly,true);
});
test("business with no entries receives valid zero summaries",async()=>{
  const f=await fixture();
  const day=await report(f,"DAILY","2026-11-20");
  const year=await report(f,"YEARLY","2026");
  assert.equal(day.totals.netMovementLkr,"0.00");
  assert.equal(day.dailyBreakdown.length,1);
  assert.equal(year.monthlyBreakdown.length,12);
  assert.equal(year.categoryBreakdown.length,0);
});
test("an issued unpaid sales invoice cannot become cashbook income",async()=>{
  const f=await fixture();
  await issueInvoice({
    businessId:f.businessId,userId:f.userId,
    customerName:"Unpaid customer",
    idempotencyKey:"report-invoice-"+uid(),
    lines:[{description:"Unpaid goods",quantity:"1.00",unitPriceLkr:"2500.00"}],
  });
  const r=await report(f,"YEARLY","2026");
  assert.equal(r.totals.cashInLkr,"0.00");
  assert.equal(r.totals.netMovementLkr,"0.00");
  assert.equal(r.invoiceAmountsIncluded,false);
});
test("edited transaction appears once at new date and corrected amount",async()=>{
  const f=await fixture();
  const id=await cash(f,"INCOME","500.00","2026-11-20");
  await updateActiveCashEntry({
    businessId:f.businessId,userId:f.userId,transactionId:id,expectedVersion:1,
    amountLkr:"125.45",category:"Adjusted sales",description:"Recounted",
    occurredOn:"2026-11-19",reason:"Cash reconciliation correction",
  });
  assert.equal((await report(f,"DAILY","2026-11-20")).totals.cashInLkr,"0.00");
  const corrected=await report(f,"DAILY","2026-11-19");
  assert.equal(corrected.totals.cashInLkr,"125.45");
  assert.equal(corrected.totals.incomeEntries,1);
  assert.equal(corrected.categoryBreakdown[0].category,"Adjusted sales");
});
test("reports only read own business and reject another business's actor",async()=>{
  const a=await fixture(),b=await fixture();
  await cash(a,"INCOME","50.00","2026-11-20");
  await cash(b,"INCOME","90.00","2026-11-20");
  assert.equal((await report(a,"DAILY","2026-11-20")).totals.cashInLkr,"50.00");
  assert.equal((await report(b,"DAILY","2026-11-20")).totals.cashInLkr,"90.00");
  await assert.rejects(()=>previewCashbookReport({
    businessId:a.businessId,userId:b.userId,period:"DAILY",periodKey:"2026-11-20",
  }),error("REPORT_PERMISSION_DENIED"));
});
test("reports.generate permission is required independent of cashbook access",async()=>{
  const f=await fixture({permissions:["transactions.create"]});
  await cash(f,"INCOME","90.00","2026-11-20");
  await assert.rejects(()=>report(f,"DAILY","2026-11-20"),error("REPORT_PERMISSION_DENIED"));
});
test("held, expired and suspended businesses cannot generate fresh reports",async()=>{
  const cases=[
    await fixture({status:"PAST_DUE"}),
    await fixture({expired:true}),
    await fixture({businessStatus:"SUSPENDED"}),
  ];
  for(const f of cases){
    await assert.rejects(()=>report(f,"YEARLY","2026"),e=>{
      assert.ok(e instanceof CashbookReportError);
      assert.ok(["REPORT_SUBSCRIPTION_NOT_ELIGIBLE","REPORT_BUSINESS_NOT_ACTIVE"].includes(e.code));
      return true;
    });
  }
});
test("active verified trial may preview cash reports",async()=>{
  const f=await fixture({status:"TRIALING"});
  await cash(f,"INCOME","29.99","2026-11-20");
  assert.equal((await report(f,"DAILY","2026-11-20")).totals.cashInLkr,"29.99");
});
test("invalid future, malformed, non-Monday or unsupported period fails before DB",async()=>{
  const f=await fixture();
  for(const [period,periodKey] of [
    ["DAILY","2026-02-30"],["WEEKLY","2026-11-17"],
    ["DAILY","2099-01-01"],["YEARLY","2099"],
    ["YEARLY","99"],["MONTHLY","2026-11-01"],
  ]){
    await assert.rejects(()=>previewCashbookReport({
      businessId:f.businessId,userId:f.userId,
      period:period as CashbookReportPeriod,periodKey,
    },async()=>{throw Error("DB_CALLED");}),e=>{
      assert.ok(e instanceof CashbookReportError);
      assert.ok(["INVALID_REPORT_PERIOD","INVALID_REPORT_REQUEST"].includes(e.code));
      return true;
    });
  }
});
test("report read does not create historical PDF snapshots or any new cash entries",async()=>{
  const f=await fixture();
  await cash(f,"INCOME","14.50","2026-11-20");
  const before=await rows(
    "SELECT COUNT(*) AS n FROM archived_report_snapshots WHERE business_id=?",
    [f.businessId]
  );
  const n=await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",
    [f.businessId]);
  const r=await report(f,"YEARLY","2026");
  assert.equal(r.reportSnapshotSaved,false);
  assert.equal(r.pdfGenerated,false);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM archived_report_snapshots WHERE business_id=?",
    [f.businessId]))[0]?.n),Number(before[0]?.n));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",
    [f.businessId]))[0]?.n),Number(n[0]?.n));
});
test("production and disabled preview fail closed before database access",async()=>{
  const f=await fixture();
  const request={businessId:f.businessId,userId:f.userId,period:"DAILY" as const,
    periodKey:"2026-11-20"};
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(()=>previewCashbookReport(request,async()=>{throw Error("DB_CALLED");}),
      error("CASHBOOK_REPORTS_DISABLED"));
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_REPORT_PREVIEW_ENABLED="false";
    await assert.rejects(()=>previewCashbookReport(request,async()=>{throw Error("DB_CALLED");}),
      error("CASHBOOK_REPORTS_DISABLED"));
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_REPORT_PREVIEW_ENABLED="true";
  }
});
test("HTTP preview requires a session, strict queries, tenant rights and no writes",async()=>{
  const f=await fixture(),other=await fixture(),nonce=uid();
  const app=express();
  app.use(express.json({limit:"20kb"}));
  app.use(session({
    secret:"noteto-report-ci-long-session-secret-for-test-only",
    resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax"},
  }));
  app.post("/__ci/login",(req,res,next)=>{
    if(req.get("X-CI-Nonce")!==nonce){res.sendStatus(403);return;}
    req.session.userId=f.userId;
    req.session.save(e=>e?next(e):res.json({success:true}));
  });
  app.use("/api/reports",reportRoutes);
  const server=createServer(app);
  try{
    await new Promise<void>((resolve,reject)=>{
      server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
    });
    const base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
    const url=base+"/api/reports/businesses/"+f.businessId+"/preview"+
      "?period=DAILY&periodKey=2026-11-20";
    assert.equal((await fetch(url)).status,401);
    const login=await fetch(base+"/__ci/login",{
      method:"POST",headers:{"X-CI-Nonce":nonce},
    });
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")?.split(";")[0];assert.ok(cookie);
    const ok=await fetch(url,{headers:{Cookie:cookie}});
    assert.equal(ok.status,200);
    const result=await ok.json() as {report:{basis:string;cashbookOnly:boolean}};
    assert.equal(result.report.basis,"CASH");
    assert.equal(result.report.cashbookOnly,true);
    assert.equal((await fetch(url+"&includeInvoices=true",{headers:{Cookie:cookie}})).status,400);
    const foreign=await fetch(url.replace(f.businessId,other.businessId),{
      headers:{Cookie:cookie},
    });
    assert.equal(foreign.status,403);
    assert.equal((await fetch(url,{method:"POST",headers:{Cookie:cookie}})).status,405);
    try{
      process.env.NODE_ENV="production";
      assert.equal((await fetch(url,{headers:{Cookie:cookie}})).status,503);
    }finally{process.env.NODE_ENV="development";}
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
