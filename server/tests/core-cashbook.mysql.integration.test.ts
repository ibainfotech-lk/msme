import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import session from "express-session";
import mysql, { type RowDataPacket } from "mysql2/promise";
import runtimePool from "../src/config/database";
import transactionRoutes from "../src/routes/transaction.routes";
import {
  createCashEntry, updateActiveCashEntry, listActiveCashEntries, CoreCashbookError,
  type CreateCashEntryInput, type UpdateCashEntryInput,
} from "../src/modules/transactions/core-cashbook.service";

/* Destructive fixtures: disposable GitHub Actions MySQL 8.4 ONLY. */
const guard = process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.RUNNER_OS === "Linux" &&
  process.env.GITHUB_REPOSITORY === "ibainfotech-lk/msme" &&
  process.env.NODE_ENV === "development" &&
  process.env.NOTETO_CI_DISPOSABLE_DB === "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
  process.env.DB_HOST === "127.0.0.1" && process.env.DB_PORT === "3307" &&
  process.env.DB_NAME === "noteto_dev" && process.env.DB_USER === "noteto_services" &&
  process.env.DB_PASSWORD === "ci_dummy_unused_password";
if (!guard) throw Error("STOP: F17 fixtures require disposable CI MySQL 8.4 only");
process.env.NOTETO_F17_BOOKKEEPING_ENABLED = "true";
const db = mysql.createPool({
  host: "127.0.0.1",port:3307,database:"noteto_dev",user:"noteto_services",
  password:"ci_dummy_unused_password",timezone:"Z",decimalNumbers:false,connectionLimit:8,
});
after(async()=>{await db.end();await runtimePool.end();});
const uid=()=>randomUUID();
interface Row extends RowDataPacket {
  n?:number; token?:string; version?:number; amount_lkr?:string;
  transaction_type?:string; occurred_on?:string; status?:string;
}
async function rows(sql:string, params:unknown[]=[]):Promise<Row[]> {
  const [r]=await db.execute<Row[]>(sql,params);return r;
}
before(async()=>{
  assert.equal((await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"))[0]?.token,
    "ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  assert.match(String((await rows("SELECT VERSION() AS token"))[0]?.token),/^8\.4\./);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"))[0]?.n), 22);
  for(const permission of ["transactions.create","transactions.read","transactions.update"]) {
    await db.execute(
      "INSERT INTO permissions(id,`key`,description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE `key`=`key`",
      [uid(),permission,"CI F17 cashbook"]
    );
  }
});
interface Fixture {businessId:string;userId:string;roleId:string;subscriptionId:string}
async function fixture(options:{
  subscriptionStatus?:"ACTIVE"|"TRIALING"|"PAST_DUE";
  businessStatus?:"ACTIVE"|"SUSPENDED";
  permissions?:string[];
  expired?:boolean;
}={}):Promise<Fixture>{
  const businessId=uid(),userId=uid(),roleId=uid(),planId=uid(),subscriptionId=uid();
  const con=await db.getConnection();
  try{
    await con.beginTransaction();
    await con.execute(
      "INSERT INTO users(id,phone,status,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [userId,"+9477"+String(Math.floor(Math.random()*10000000)).padStart(7,"0")]
    );
    await con.execute(
      "INSERT INTO businesses(id,name,registration_type,status,updated_at) VALUES (?,'F17 CI','SOLE_PROPRIETOR',?,UTC_TIMESTAMP(3))",
      [businessId,options.businessStatus??"ACTIVE"]
    );
    await con.execute(
      "INSERT INTO roles(id,business_id,name,is_system_role,updated_at) VALUES (?,?,'OWNER',1,UTC_TIMESTAMP(3))",
      [roleId,businessId]
    );
    for(const permission of options.permissions??["transactions.create","transactions.read","transactions.update"]) {
      await con.execute(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE `key`=?",
        [roleId,permission]
      );
    }
    await con.execute(
      "INSERT INTO business_memberships(id,business_id,user_id,role_id,status,updated_at) VALUES (?,?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",
      [uid(),businessId,userId,roleId]
    );
    await con.execute(
      ["INSERT INTO subscription_plans",
       "(id,code,name,price_lkr,billing_interval,trial_days,invoice_limit,is_active,updated_at)",
       "VALUES (?,?,'F17 CASH',499.00,'MONTHLY',0,30,1,UTC_TIMESTAMP(3))"].join(" "),
      [planId,"CI_F17_"+uid().replace(/-/g,"").toUpperCase()]
    );
    await con.execute(
      ["INSERT INTO business_subscriptions",
       "(id,business_id,plan_id,status,starts_at,current_period_end,trial_ends_at,held_at,updated_at)",
       "VALUES (?,?,?,?,'2026-09-01 00:00:00.000',?,?,?,UTC_TIMESTAMP(3))"].join(" "),
      [
        subscriptionId,businessId,planId,options.subscriptionStatus??"ACTIVE",
        options.expired?"2026-10-01 00:00:00.000":"2027-12-31 23:59:59.000",
        options.expired?"2026-10-01 00:00:00.000":"2027-12-31 23:59:59.000",
        options.subscriptionStatus==="PAST_DUE"?"2026-11-01 00:00:00.000":null,
      ]
    );
    await con.execute("UPDATE businesses SET current_subscription_id=? WHERE id=?",
      [subscriptionId,businessId]);
    await con.commit();
  }catch(e){await con.rollback();throw e;}finally{con.release();}
  return {businessId,userId,roleId,subscriptionId};
}
function createInput(f:Fixture,changes:Partial<CreateCashEntryInput>={}):CreateCashEntryInput{
  return {
    businessId:f.businessId,userId:f.userId,transactionType:"INCOME",
    cashConfirmed:true,amountLkr:"1500.00",category:"Sales",
    description:"Cash received for sold goods",occurredOn:"2026-11-20",
    idempotencyKey:"f17-"+uid(),...changes,
  };
}
function updateInput(f:Fixture,transactionId:string,changes:Partial<UpdateCashEntryInput>={}):UpdateCashEntryInput{
  return {
    businessId:f.businessId,userId:f.userId,transactionId,expectedVersion:1,
    amountLkr:"1450.00",category:"Sales corrected",
    description:"Correct cash receipt",occurredOn:"2026-11-19",
    reason:"Correct counted cash",...changes,
  };
}
function err(code:string){
  return (error:unknown):boolean=>{
    assert.ok(error instanceof CoreCashbookError);
    assert.equal(error.code,code);return true;
  };
}
test("create confirmed income preserves exact LKR amount, tenant and cash date",async()=>{
  const f=await fixture(),r=await createCashEntry(createInput(f));
  assert.equal(r.created,true);assert.equal(r.version,1);
  assert.equal(r.reportGenerated,false);assert.equal(r.invoiceCreated,false);
  const entry=await rows("SELECT amount_lkr,transaction_type,DATE_FORMAT(occurred_on,'%Y-%m-%d') AS occurred_on FROM cash_transactions WHERE id=? AND business_id=?",
    [r.transactionId,f.businessId]);
  assert.equal(String(entry[0]?.amount_lkr),"1500.00");
  assert.equal(entry[0]?.transaction_type,"INCOME");
  assert.equal(entry[0]?.occurred_on,"2026-11-20");
});
test("expense records actual cash paid, not unpaid supplier invoices",async()=>{
  const f=await fixture(),result=await createCashEntry(createInput(f,{
    transactionType:"EXPENSE",amountLkr:"300.50",category:"Supplies",
    description:"Cash paid for supplies",
  }));
  assert.equal((await rows("SELECT transaction_type AS token FROM cash_transactions WHERE id=?",
    [result.transactionId]))[0]?.token,"EXPENSE");
});
test("cash confirmation is mandatory; unpaid invoice cannot create cashbook row",async()=>{
  const f=await fixture();
  await assert.rejects(()=>createCashEntry(createInput(f,{cashConfirmed:false as true}),
    async()=>{throw Error("UNEXPECTED_DB");}),err("CASH_CONFIRMATION_REQUIRED"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",[f.businessId]))[0]?.n),0);
});
test("valid idempotent replay returns same entry; changed payload is rejected",async()=>{
  const f=await fixture(),input=createInput(f);
  const one=await createCashEntry(input),two=await createCashEntry(input);
  assert.equal(two.transactionId,one.transactionId);
  assert.equal(two.replayed,true);assert.equal(two.created,false);
  await assert.rejects(()=>createCashEntry({...input,amountLkr:"1600.00"}),err("CASH_REQUEST_REPLAY_CONFLICT"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",[f.businessId]))[0]?.n),1);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transaction_create_requests WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("concurrent identical create requests make exactly one row",async()=>{
  const f=await fixture(),input=createInput(f);
  const [a,b]=await Promise.all([createCashEntry(input),createCashEntry(input)]);
  assert.equal(a.transactionId,b.transactionId);
  assert.equal([a.created,b.created].filter(Boolean).length,1);
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",[f.businessId]))[0]?.n),1);
});
test("list is tenant-scoped, ordered, and does not expose another business",async()=>{
  const a=await fixture(),b=await fixture();
  const a1=await createCashEntry(createInput(a,{occurredOn:"2026-11-17"}));
  await createCashEntry(createInput(b));
  const a2=await createCashEntry(createInput(a,{occurredOn:"2026-11-18",transactionType:"EXPENSE"}));
  const result=await listActiveCashEntries({businessId:a.businessId,userId:a.userId});
  assert.equal(result.mode,"FULL");
  assert.deepEqual(result.items.map(x=>x.id),[a2.transactionId,a1.transactionId]);
  assert.equal(result.reportGenerated,false);
});
test("keyset pagination returns each transaction once",async()=>{
  const f=await fixture();
  const ids=[];
  for(const occurredOn of ["2026-11-16","2026-11-17","2026-11-18"])
    ids.push((await createCashEntry(createInput(f,{occurredOn}))).transactionId);
  const first=await listActiveCashEntries({businessId:f.businessId,userId:f.userId,limit:2});
  assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const second=await listActiveCashEntries({
    businessId:f.businessId,userId:f.userId,limit:2,cursor:first.nextCursor!,
  });
  assert.equal(second.items.length,1);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,3);
});
test("edit keeps transaction type and inserts a single atomic audit",async()=>{
  const f=await fixture();
  const original=await createCashEntry(createInput(f,{transactionType:"EXPENSE"}));
  const result=await updateActiveCashEntry(updateInput(f,original.transactionId));
  assert.equal(result.version,2);assert.equal(result.created,false);
  const changed=await rows("SELECT transaction_type,amount_lkr,version FROM cash_transactions WHERE id=?",
    [original.transactionId]);
  assert.equal(changed[0]?.transaction_type,"EXPENSE");
  assert.equal(String(changed[0]?.amount_lkr),"1450.00");
  assert.equal(changed[0]?.version,2);
  const aud=await rows("SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id=?",
    [original.transactionId]);
  assert.equal(Number(aud[0]?.n),1);
});
test("stale and concurrent edits cannot overwrite newer version or double audit",async()=>{
  const f=await fixture(),created=await createCashEntry(createInput(f));
  const inp=updateInput(f,created.transactionId);
  const outcomes=await Promise.allSettled([
    updateActiveCashEntry(inp),
    updateActiveCashEntry({...inp,amountLkr:"1550.00",reason:"Correct actual receipt"}),
  ]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  await assert.rejects(()=>updateActiveCashEntry(inp),err("CASH_ENTRY_VERSION_CONFLICT"));
  assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transaction_edit_audits WHERE cash_transaction_id=?",
    [created.transactionId]))[0]?.n),1);
});
test("cannot edit another business's UUID",async()=>{
  const a=await fixture(),b=await fixture(),created=await createCashEntry(createInput(b));
  await assert.rejects(()=>updateActiveCashEntry(updateInput(a,created.transactionId)),
    err("CASH_ENTRY_NOT_FOUND"));
});
test("missing write or read permissions deny each corresponding operation",async()=>{
  const f=await fixture({permissions:["transactions.read"]});
  await assert.rejects(()=>createCashEntry(createInput(f)),err("CASHBOOK_PERMISSION_DENIED"));
  const g=await fixture({permissions:["transactions.create"]});
  await assert.rejects(()=>listActiveCashEntries({businessId:g.businessId,userId:g.userId}),
    err("CASHBOOK_PERMISSION_DENIED"));
  const created=await createCashEntry(createInput(g));
  await assert.rejects(()=>updateActiveCashEntry(updateInput(g,created.transactionId)),
    err("CASHBOOK_PERMISSION_DENIED"));
});
test("account hold, expired subscription and suspended business prevent new entry",async()=>{
  for(const f of [
    await fixture({subscriptionStatus:"PAST_DUE"}),
    await fixture({expired:true}),
    await fixture({businessStatus:"SUSPENDED"}),
  ]) {
    await assert.rejects(()=>createCashEntry(createInput(f)),(e:unknown)=>{
      assert.ok(e instanceof CoreCashbookError);
      assert.ok(["SUBSCRIPTION_NOT_WRITABLE","BUSINESS_NOT_ACTIVE"].includes(e.code));
      return true;
    });
    assert.equal(Number((await rows("SELECT COUNT(*) AS n FROM cash_transactions WHERE business_id=?",
      [f.businessId]))[0]?.n),0);
  }
});
test("verified unexpired trial allows a confirmed cash entry",async()=>{
  const f=await fixture({subscriptionStatus:"TRIALING"});
  const result=await createCashEntry(createInput(f));
  assert.equal(result.created,true);
});
test("invalid amounts, future dates and malformed dates fail before DB",async()=>{
  const f=await fixture();
  for(const changes of [
    {amountLkr:"0.00"},{amountLkr:"-5.00"},{amountLkr:"100"},{amountLkr:"1.234"},
    {amountLkr:"10000000000.00"},{occurredOn:"2026-02-30"},
    {occurredOn:"2099-01-01"},{category:"   "},
  ]) {
    await assert.rejects(()=>createCashEntry(createInput(f,changes),async()=>{
      throw Error("UNEXPECTED_DB");
    }),(e:unknown)=>{
      assert.ok(e instanceof CoreCashbookError);
      assert.equal(e.code,"INVALID_CASH_ENTRY");return true;
    });
  }
});
test("production and disabled feature reject before database connection",async()=>{
  const f=await fixture(),entry=createInput(f);
  try {
    process.env.NODE_ENV="production";
    await assert.rejects(()=>createCashEntry(entry,async()=>{throw Error("UNEXPECTED_DB")}),
      err("CORE_BOOKKEEPING_DISABLED"));
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_BOOKKEEPING_ENABLED="false";
    await assert.rejects(()=>listActiveCashEntries({businessId:f.businessId,userId:f.userId},
      async()=>{throw Error("UNEXPECTED_DB")}),err("CORE_BOOKKEEPING_DISABLED"));
  } finally {
    process.env.NODE_ENV="development";
    process.env.NOTETO_F17_BOOKKEEPING_ENABLED="true";
  }
});
test("HTTP session, same-origin enforcement, cross-tenant and forbidden DELETE",async()=>{
  const f=await fixture(),other=await fixture(),nonce=uid();
  const app=express();
  app.use(express.json({limit:"20kb"}));
  app.use(session({secret:"noteto-f17-ci-only-long-session-secret-for-tests",
    resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:"lax"}}));
  app.post("/__ci/auth",(req,res,next)=>{
    if(req.get("X-CI-Nonce")!==nonce){res.sendStatus(403);return;}
    req.session.userId=f.userId;
    req.session.save(err=>err?next(err):res.json({success:true}));
  });
  app.use("/api/transactions",transactionRoutes);
  const server=createServer(app);
  try {
    await new Promise<void>((resolve,reject)=>{
      server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
    });
    const base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
    const path="/api/transactions/businesses/"+f.businessId;
    assert.equal((await fetch(base+path)).status,401);
    const login=await fetch(base+"/__ci/auth",{method:"POST",headers:{"X-CI-Nonce":nonce}});
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")?.split(";")[0];assert.ok(cookie);
    const body=createInput(f);
    const withoutOrigin=await fetch(base+path,{
      method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie},
      body:JSON.stringify({
        transactionType:body.transactionType,amountLkr:body.amountLkr,
        category:body.category,description:body.description,
        occurredOn:body.occurredOn,cashConfirmed:true,
        idempotencyKey:body.idempotencyKey,
      }),
    });
    assert.equal(withoutOrigin.status,403);
    const malicious=await fetch(base+path,{
      method:"POST",
      headers:{"Content-Type":"application/json",Cookie:cookie,Origin:"https://malicious.example"},
      body:JSON.stringify({
        transactionType:body.transactionType,amountLkr:body.amountLkr,
        category:body.category,description:body.description,
        occurredOn:body.occurredOn,cashConfirmed:true,idempotencyKey:body.idempotencyKey,
      }),
    });
    assert.equal(malicious.status,403);
    const data={transactionType:body.transactionType,amountLkr:body.amountLkr,
      category:body.category,description:body.description,occurredOn:body.occurredOn,
      cashConfirmed:true,idempotencyKey:body.idempotencyKey};
    const created=await fetch(base+path,{method:"POST",headers:{
      "Content-Type":"application/json",Cookie:cookie,Origin:"http://localhost:5173",
    },body:JSON.stringify(data)});
    assert.equal(created.status,201);
    const record=await created.json() as {transactionId:string};
    assert.ok(record.transactionId);
    const foreign=await fetch(base+"/api/transactions/businesses/"+other.businessId,{
      headers:{Cookie:cookie},
    });
    assert.equal(foreign.status,403);
    const listed=await fetch(base+path,{headers:{Cookie:cookie}});
    assert.equal(listed.status,200);
    const list=await listed.json() as {items:unknown[]};
    assert.equal(list.items.length,1);
    const patch=await fetch(base+path+"/"+record.transactionId,{
      method:"PATCH",headers:{
        "Content-Type":"application/json",Cookie:cookie,Origin:"http://localhost:5173",
      },body:JSON.stringify({
        expectedVersion:1,amountLkr:"1400.00",category:"Corrected",
        description:"Corrected sales",occurredOn:"2026-11-19",reason:"Recounted cash",
      }),
    });
    assert.equal(patch.status,200);
    const blocked=await fetch(base+path+"/"+record.transactionId,{
      method:"DELETE",headers:{Cookie:cookie,Origin:"http://localhost:5173"},
    });
    assert.equal(blocked.status,405);
    try{
      process.env.NODE_ENV="production";
      const prod=await fetch(base+path,{headers:{Cookie:cookie}});
      assert.equal(prod.status,503);
    }finally{process.env.NODE_ENV="development";}
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
