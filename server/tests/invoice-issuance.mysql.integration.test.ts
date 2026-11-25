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
import invoiceRoutes from "../src/modules/invoices/invoice.routes";
import {
  issueInvoice,getInvoice,listInvoices,getInvoiceQuota,InvoiceIssueError,
  type IssueInvoiceInput,
} from "../src/modules/invoices/invoice-issuance.service";

/* Fixture writes only on disposable GitHub Actions MySQL 8.4. */
const guard=process.env.CI==="true" && process.env.GITHUB_ACTIONS==="true" &&
  process.env.RUNNER_OS==="Linux" &&
  process.env.GITHUB_REPOSITORY==="ibainfotech-lk/msme" &&
  process.env.NODE_ENV==="development" &&
  process.env.NOTETO_CI_DISPOSABLE_DB==="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
  process.env.DB_HOST==="127.0.0.1" && process.env.DB_PORT==="3307" &&
  process.env.DB_NAME==="noteto_dev" && process.env.DB_USER==="noteto_services" &&
  process.env.DB_PASSWORD==="ci_dummy_unused_password";
if(!guard)throw Error("STOP: F17.2 tests require ephemeral GitHub MySQL 8.4");
process.env.NOTETO_F17_INVOICING_ENABLED="true";
const db=mysql.createPool({
  host:"127.0.0.1",port:3307,user:"noteto_services",
  password:"ci_dummy_unused_password",database:"noteto_dev",
  timezone:"Z",decimalNumbers:false,connectionLimit:8,
});
const uid=()=>randomUUID();
interface Row extends RowDataPacket {
  n?:number; token?:string; invoice_number?:string; billing_month?:string;
  invoice_sequence?:number; total_lkr?:string; status?:string;
}
async function rows(sql:string,params:unknown[]=[]):Promise<Row[]>{
  const [r]=await db.execute<Row[]>(sql,params);return r;
}
after(async()=>{await db.end();await runtimePool.end();});
before(async()=>{
  assert.equal((await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"))[0]?.token,
    "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  assert.match(String((await rows("SELECT VERSION() AS token"))[0]?.token),/^8\.4\./);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"))[0]?.n), 24);
  for(const key of ["invoices.create","invoices.read"]){
    await db.execute(
      "INSERT INTO permissions(id,`key`,description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `key`=`key`",
      [uid(),key,"CI invoice permission"]
    );
  }
});
interface Fixture {businessId:string;userId:string;subscriptionId:string;roleId:string}
async function fixture(options:{
  status?:"ACTIVE"|"TRIALING"|"PAST_DUE";
  businessStatus?:"ACTIVE"|"SUSPENDED";
  expired?:boolean;
  invoiceLimit?:number;
  permissions?:string[];
}={}):Promise<Fixture>{
  const businessId=uid(),userId=uid(),subscriptionId=uid(),planId=uid(),roleId=uid();
  const con=await db.getConnection();
  try{
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users(id,phone,status,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [userId,"+9477"+String(Math.floor(Math.random()*10000000)).padStart(7,"0")]
    );
    await con.execute(
      "INSERT INTO businesses(id,name,registration_type,status,updated_at) VALUES (?,'CI F17 INVOICE','SOLE_PROPRIETOR',?,UTC_TIMESTAMP(3))",
      [businessId,options.businessStatus??"ACTIVE"]
    );
    await con.execute(
      "INSERT INTO roles(id,business_id,name,is_system_role,updated_at) VALUES (?,?,'OWNER',1,UTC_TIMESTAMP(3))",
      [roleId,businessId]
    );
    for(const key of options.permissions??["invoices.create","invoices.read"]){
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
       "VALUES (?,?,'F17 INVOICING',499.00,'MONTHLY',0,?,1,UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_IV_"+uid().replace(/-/g,"").toUpperCase(),options.invoiceLimit??30]
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
    await con.execute(
      "UPDATE businesses SET current_subscription_id=? WHERE id=?",[subscriptionId,businessId]
    );
    await con.commit();
  }catch(e){await con.rollback();throw e;}finally{con.release();}
  return {businessId,userId,subscriptionId,roleId};
}
function input(f:Fixture,changes:Partial<IssueInvoiceInput>={}):IssueInvoiceInput{
  return {
    businessId:f.businessId,userId:f.userId,
    customerName:"Northern Bakery",customerEmail:"accounts@example.com",
    notes:"Payable at the customer counter",
    lines:[
      {description:"Delivered bread",quantity:"2.00",unitPriceLkr:"250.00"},
      {description:"Delivery charge",quantity:"0.50",unitPriceLkr:"100.00"},
    ],
    idempotencyKey:"test-invoice-"+uid(),...changes,
  };
}
function err(code:string){
  return (e:unknown):boolean=>{
    assert.ok(e instanceof InvoiceIssueError);
    assert.equal(e.code,code);return true;
  };
}
test("issue an invoice with two lines, LKR totals, but no money received",async()=>{
  const f=await fixture(),r=await issueInvoice(input(f));
  assert.equal(r.totalLkr,"550.00");
  assert.equal(r.invoiceNumber.slice(0,3),"NT-");
  assert.equal(r.quota.used,1);
  assert.equal(r.quota.remaining,29);
  assert.equal(r.quota.warningAt28,false);
  assert.equal(r.cashbookEntryCreated,false);
  assert.equal(r.paymentCollected,false);
  const detail=await getInvoice({businessId:f.businessId,userId:f.userId,invoiceId:r.id});
  assert.equal(detail.lines.length,2);
  assert.deepEqual(detail.lines.map(x=>x.lineTotalLkr),["500.00","50.00"]);
  assert.equal(detail.customerName,"Northern Bakery");
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",[f.businessId]))[0]?.n),0);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM platform_payment_transactions WHERE business_id=?",[f.businessId]))[0]?.n),0);
});
test("cent precision rounds each line deterministically without floating point",async()=>{
  const f=await fixture(),r=await issueInvoice(input(f,{
    lines:[{description:"Fractional service",quantity:"0.33",unitPriceLkr:"0.02"}],
  }));
  assert.equal(r.totalLkr,"0.01");
  assert.equal((await getInvoice({businessId:f.businessId,userId:f.userId,invoiceId:r.id})).lines[0].lineTotalLkr,"0.01");
});
test("exact idempotent replay is safe and conflict changes cannot create another invoice",async()=>{
  const f=await fixture(),request=input(f);
  const first=await issueInvoice(request);
  const again=await issueInvoice(request);
  assert.equal(again.id,first.id);
  assert.equal(again.replayed,true);
  await assert.rejects(()=>issueInvoice({...request,customerName:"Other customer"}),err("INVOICE_IDEMPOTENCY_CONFLICT"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM sales_invoices WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("simultaneous duplicate requests create one invoice",async()=>{
  const f=await fixture(),request=input(f);
  const [one,two]=await Promise.all([issueInvoice(request),issueInvoice(request)]);
  assert.equal(one.id,two.id);
  assert.equal([one.replayed,two.replayed].filter(Boolean).length,1);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM sales_invoices WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("invoice 28 warns, invoice 30 is final, invoice 31 is refused",async()=>{
  const f=await fixture();
  let invoice28;let invoice30;
  for(let i=1;i<=30;i++){
    const r=await issueInvoice(input(f,{customerName:"Customer "+i}));
    if(i===28)invoice28=r;
    if(i===30)invoice30=r;
  }
  assert.equal(invoice28?.quota.used,28);
  assert.equal(invoice28?.quota.warningAt28,true);
  assert.equal(invoice28?.quota.remaining,2);
  assert.equal(invoice30?.quota.used,30);
  assert.equal(invoice30?.quota.remaining,0);
  assert.equal(invoice30?.quota.warningAt28,true);
  await assert.rejects(()=>issueInvoice(input(f)),err("INVOICE_MONTHLY_LIMIT_REACHED"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM sales_invoices WHERE business_id=?",[f.businessId]))[0]?.n),30);
  assert.equal(invoice30?.invoiceNumber.slice(-4),"0030");
});
test("a plan configured for 2 invoices enforces its lower limit",async()=>{
  const f=await fixture({invoiceLimit:2});
  await issueInvoice(input(f));
  const r=await issueInvoice(input(f));
  assert.equal(r.quota.remaining,0);
  await assert.rejects(()=>issueInvoice(input(f)),err("INVOICE_MONTHLY_LIMIT_REACHED"));
});
test("simultaneous requests cannot exceed last available invoice slot",async()=>{
  const f=await fixture({invoiceLimit:1});
  const result=await Promise.allSettled([issueInvoice(input(f)),issueInvoice(input(f))]);
  assert.equal(result.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM sales_invoices WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("invoice list and detail are business scoped",async()=>{
  const a=await fixture(),b=await fixture();
  const one=await issueInvoice(input(a));
  await issueInvoice(input(b));
  const mine=await listInvoices({businessId:a.businessId,userId:a.userId});
  assert.equal(mine.items.length,1);
  assert.equal(mine.items[0].id,one.id);
  const otherInvoices=await listInvoices({businessId:b.businessId,userId:b.userId});
  const otherInvoiceId=otherInvoices.items[0].id;
  await assert.rejects(()=>getInvoice({
    businessId:a.businessId,userId:a.userId,invoiceId:otherInvoiceId,
  }),err("INVOICE_NOT_FOUND"));
  await assert.rejects(()=>listInvoices({businessId:b.businessId,userId:a.userId}),
    err("INVOICE_PERMISSION_DENIED"));
});
test("invoice history supports stable keyset pagination",async()=>{
  const f=await fixture();
  for(let i=0;i<3;i++)await issueInvoice(input(f,{customerName:"Page "+i}));
  const page1=await listInvoices({businessId:f.businessId,userId:f.userId,limit:2});
  assert.equal(page1.items.length,2);
  assert.ok(page1.nextCursor);
  const page2=await listInvoices({businessId:f.businessId,userId:f.userId,limit:2,
    cursor:page1.nextCursor!});
  assert.equal(page2.items.length,1);
  assert.equal(new Set([...page1.items,...page2.items].map(x=>x.id)).size,3);
});
test("current-month quota lookup is authoritative, read-only, and tenant-authorized",async()=>{
  const f=await fixture({invoiceLimit:2});
  const before=await getInvoiceQuota({businessId:f.businessId,userId:f.userId});
  assert.equal(before.quota.used,0);
  assert.equal(before.quota.remaining,2);
  await issueInvoice(input(f));
  const afterOne=await getInvoiceQuota({businessId:f.businessId,userId:f.userId});
  assert.equal(afterOne.quota.used,1);
  assert.equal(afterOne.quota.remaining,1);
  assert.equal(afterOne.quota.warningAt28,false);
  const other=await fixture();
  await assert.rejects(()=>getInvoiceQuota({businessId:f.businessId,userId:other.userId}),
    err("INVOICE_PERMISSION_DENIED"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",
    [f.businessId]))[0]?.n),0);
});
test("permission checks distinguish issue from reading",async()=>{
  const readonly=await fixture({permissions:["invoices.read"]});
  await assert.rejects(()=>issueInvoice(input(readonly)),err("INVOICE_PERMISSION_DENIED"));
  const writeonly=await fixture({permissions:["invoices.create"]});
  const made=await issueInvoice(input(writeonly));
  await assert.rejects(()=>getInvoice({businessId:writeonly.businessId,userId:writeonly.userId,invoiceId:made.id}),
    err("INVOICE_PERMISSION_DENIED"));
});
test("held, suspended, expired and pending subscriptions cannot issue invoices",async()=>{
  for(const f of [
    await fixture({status:"PAST_DUE"}),
    await fixture({businessStatus:"SUSPENDED"}),
    await fixture({expired:true}),
  ]){
    await assert.rejects(()=>issueInvoice(input(f)),e=>{
      assert.ok(e instanceof InvoiceIssueError);
      assert.ok(["INVOICE_SUBSCRIPTION_NOT_ELIGIBLE","INVOICE_BUSINESS_NOT_ACTIVE"].includes(e.code));
      return true;
    });
  }
});
test("current verified trial may issue a normal invoice without payment",async()=>{
  const f=await fixture({status:"TRIALING"});
  assert.equal((await issueInvoice(input(f))).quota.used,1);
});
test("invalid line amounts, empty customer, more than 20 lines and incorrect types fail before DB",async()=>{
  const f=await fixture(),valid=input(f);
  for(const changes of [
    {customerName:"  "},{lines:[]},{lines:Array.from({length:21},()=>valid.lines[0])},
    {lines:[{description:"x",quantity:"1.00",unitPriceLkr:"100.00"}]},
    {lines:[{description:"Valid",quantity:"0.00",unitPriceLkr:"100.00"}]},
    {lines:[{description:"Valid",quantity:"1.00",unitPriceLkr:"0.00"}]},
    {lines:[{description:"Valid",quantity:"3",unitPriceLkr:"100.00"}]},
    {lines:[{description:"Valid",quantity:"1.00",unitPriceLkr:"99999999999.99"}]},
  ]){
    await assert.rejects(()=>issueInvoice(input(f,changes),async()=>{throw Error("UNEXPECTED_DB")}),
      e=>{assert.ok(e instanceof InvoiceIssueError);return true;});
  }
});
test("production or missing feature switch fails before a database connection",async()=>{
  const f=await fixture(),request=input(f);
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(()=>issueInvoice(request,async()=>{throw Error("DB_CALLED")}),
      err("INVOICING_NOT_AVAILABLE"));
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_INVOICING_ENABLED="false";
    await assert.rejects(()=>listInvoices({businessId:f.businessId,userId:f.userId},
      async()=>{throw Error("DB_CALLED")}),err("INVOICING_NOT_AVAILABLE"));
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_INVOICING_ENABLED="true";
  }
});
test("HTTP routes require session, same-origin, strict JSON and deny deletion",async()=>{
  const f=await fixture(),nonce=uid();
  const app=express();
  app.use(express.json({limit:"20kb"}));
  app.use(session({
    secret:"noteto-invoice-ci-long-session-secret-for-testing",
    resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax"},
  }));
  app.post("/__ci/login",(req,res,next)=>{
    if(req.get("X-CI-Nonce")!==nonce){res.sendStatus(403);return;}
    req.session.userId=f.userId;
    req.session.save(e=>e?next(e):res.json({success:true}));
  });
  app.use("/api/invoices",invoiceRoutes);
  const server=createServer(app);
  try{
    await new Promise<void>((resolve,reject)=>{
      server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
    });
    const base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
    const path="/api/invoices/businesses/"+f.businessId;
    assert.equal((await fetch(base+path)).status,401);
    const login=await fetch(base+"/__ci/login",{
      method:"POST",headers:{"X-CI-Nonce":nonce},
    });
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")?.split(";")[0];assert.ok(cookie);
    const b=input(f);
    const data={customerName:b.customerName,customerEmail:b.customerEmail,
      notes:b.notes,lines:b.lines,idempotencyKey:b.idempotencyKey};
    const noOrigin=await fetch(base+path,{
      method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie},
      body:JSON.stringify(data),
    });
    assert.equal(noOrigin.status,403);
    const malicious=await fetch(base+path,{
      method:"POST",headers:{
        "Content-Type":"application/json",Cookie:cookie,Origin:"https://malicious.test",
      },body:JSON.stringify(data),
    });
    assert.equal(malicious.status,403);
    const extra=await fetch(base+path,{
      method:"POST",headers:{
        "Content-Type":"application/json",Cookie:cookie,Origin:"http://localhost:5173",
      },body:JSON.stringify({...data,cashConfirmed:true}),
    });
    assert.equal(extra.status,400);
    const valid=await fetch(base+path,{
      method:"POST",headers:{
        "Content-Type":"application/json",Cookie:cookie,Origin:"http://localhost:5173",
      },body:JSON.stringify(data),
    });
    assert.equal(valid.status,201);
    const issued=await valid.json() as {invoice:{id:string}};
    assert.ok(issued.invoice.id);
    const quotaResponse=await fetch(base+path+"/quota",{headers:{Cookie:cookie}});
    assert.equal(quotaResponse.status,200);
    const q=await quotaResponse.json() as {quota:{used:number;limit:number}};
    assert.equal(q.quota.used,1);
    assert.equal(q.quota.limit,30);
    const get=await fetch(base+path+"/"+issued.invoice.id,{headers:{Cookie:cookie}});
    assert.equal(get.status,200);
    const deletion=await fetch(base+path+"/"+issued.invoice.id,{
      method:"DELETE",headers:{Cookie:cookie,Origin:"http://localhost:5173"},
    });
    assert.equal(deletion.status,405);
    try{
      process.env.NODE_ENV="production";
      assert.equal((await fetch(base+path,{headers:{Cookie:cookie}})).status,503);
    }finally{process.env.NODE_ENV="development";}
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
