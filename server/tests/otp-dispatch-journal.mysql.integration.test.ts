import "dotenv/config";
import assert from "node:assert/strict";
import {randomBytes,randomInt,randomUUID} from "node:crypto";
import {after,before,test} from "node:test";
import mysql,{type RowDataPacket} from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  OtpDispatchJournalError,
  reserveOtpDispatch,
  claimOtpDispatchAttempt,
  recordOtpDispatchAcknowledgement,
  recordOtpDispatchDelivery,
} from "../src/services/otp-dispatch-journal.service";

const allowed=
  process.env.CI==="true"&&process.env.GITHUB_ACTIONS==="true"&&
  process.env.RUNNER_OS==="Linux"&&
  process.env.GITHUB_REPOSITORY==="ibainfotech-lk/msme"&&
  process.env.NODE_ENV==="development"&&
  process.env.NOTETO_CI_DISPOSABLE_DB==="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE"&&
  process.env.DB_HOST==="127.0.0.1"&&
  process.env.DB_PORT==="3307"&&process.env.DB_NAME==="noteto_dev"&&
  process.env.DB_USER==="noteto_services"&&
  process.env.DB_PASSWORD==="ci_dummy_unused_password";
if(!allowed)throw new Error("STOP: OTP journal integration tests require ephemeral CI MySQL 8.4.");
process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="true";
process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY="noteto-disposable-ci-synthetic-key-not-for-production-123";

const db=mysql.createPool({
  host:"127.0.0.1",port:3307,database:"noteto_dev",
  user:"noteto_services",password:"ci_dummy_unused_password",
  timezone:"Z",connectionLimit:8,
});
after(async()=>{await db.end();await runtimePool.end();});
interface Row extends RowDataPacket{
  n?:number;token?:string;db_name?:string;version?:string;status?:string;
  request_sha256?:string;recipient_hmac_sha256?:string;
  provider_uid?:string|null;attempt_count?:number;event_type?:string;
}
async function rows(sql:string,params:unknown[]=[]):Promise<Row[]>{
  const [r]=await db.execute<Row[]>(sql,params);return r;
}
function error(expected:string){
  return (e:unknown)=> {
    assert.ok(e instanceof OtpDispatchJournalError);
    assert.equal(e.code,expected);
    return true;
  };
}
before(async()=>{
  const guard=await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guard[0]?.token,"ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const dbinfo=await rows("SELECT VERSION() AS version,DATABASE() AS db_name");
  assert.match(String(dbinfo[0]?.version),/^8\.4\./);
  assert.equal(dbinfo[0]?.db_name,"noteto_dev");
  const migrations=await rows(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  assert.equal(Number(migrations[0]?.n),24);
});
async function fixture(expired=false){
  const challengeId=randomUUID();
  const phoneE164="+9477"+String(randomInt(0,10_000_000)).padStart(7,"0");
  await db.execute(
    "INSERT INTO otp_verifications (id,phone,otp_hash,attempts,expires_at) "+
    "VALUES (?,?,?,0,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND))",
    [challengeId,phoneE164,"synthetic-hash-not-a-usable-otp",expired?-1:300]
  );
  return {
    challengeId,phoneE164,
    idempotencyKey:"ci_otp_"+randomBytes(20).toString("hex"),
  };
}
test("new journal schema has no phone, OTP code, message or token fields",async()=>{
  const names=(await rows(
    "SELECT column_name AS name FROM information_schema.columns "+
    "WHERE table_schema=DATABASE() AND table_name='otp_dispatch_records'"
  )).map(r=>(r as Row&{name:string}).name);
  for(const banned of ["phone","otp","message","api_token","otp_hash"]){
    assert.equal(names.includes(banned),false);
  }
  assert.ok(names.includes("recipient_hmac_sha256"));
  assert.ok(names.includes("request_sha256"));
});
test("reservation and replay create one durable journal row and one event",async()=>{
  const f=await fixture();
  const a=await reserveOtpDispatch(f);
  assert.equal(a.status,"RESERVED");
  assert.equal(a.replayed,false);
  assert.equal(a.otpVerified,false);
  assert.equal(a.businessActivated,false);
  const replay=await reserveOtpDispatch(f);
  assert.equal(replay.dispatchId,a.dispatchId);
  assert.equal(replay.replayed,true);
  const stored=await rows(
    "SELECT request_sha256,recipient_hmac_sha256,status,attempt_count "+
    "FROM otp_dispatch_records WHERE id=?",[a.dispatchId]
  );
  assert.match(stored[0].request_sha256??"",/^[a-f0-9]{64}$/);
  assert.match(stored[0].recipient_hmac_sha256??"",/^[a-f0-9]{64}$/);
  assert.equal(stored[0].status,"RESERVED");
  assert.equal(stored[0].attempt_count,0);
  const events=await rows("SELECT event_type FROM otp_dispatch_events WHERE dispatch_id=?",
    [a.dispatchId]);
  assert.deepEqual(events.map(r=>r.event_type),["RESERVED"]);
});
test("wrong phone, mismatched key and old challenge fail closed",async()=>{
  const f=await fixture();
  await reserveOtpDispatch(f);
  await assert.rejects(()=>reserveOtpDispatch({
    ...f,phoneE164:"+94770000000"
  }),error("DISPATCH_KEY_CONFLICT"));
  await assert.rejects(()=>reserveOtpDispatch({
    ...f,idempotencyKey:"ci_otp_"+randomBytes(20).toString("hex")
  }),error("DISPATCH_KEY_CONFLICT"));
  const expired=await fixture(true);
  await assert.rejects(()=>reserveOtpDispatch(expired),error("CHALLENGE_NOT_ACTIVE"));
});
test("one claim becomes DISPATCH_UNKNOWN; a second claim cannot resend",async()=>{
  const f=await fixture();
  const reserved=await reserveOtpDispatch(f);
  const claimed=await claimOtpDispatchAttempt(reserved.dispatchId);
  assert.equal(claimed.status,"DISPATCH_UNKNOWN");
  assert.equal(claimed.attemptCount,1);
  await assert.rejects(()=>claimOtpDispatchAttempt(reserved.dispatchId),
    error("DISPATCH_ALREADY_ATTEMPTED"));
  const journal=await rows(
    "SELECT event_type FROM otp_dispatch_events WHERE dispatch_id=? ORDER BY created_at,id",
    [reserved.dispatchId]
  );
  assert.equal(journal.filter(r=>r.event_type==="SEND_CLAIMED").length,1);
});
test("provider accepted UID and delivery still never authenticate customers",async()=>{
  const f=await fixture();
  const reserved=await reserveOtpDispatch(f);
  const uid="uid_"+randomBytes(14).toString("hex");
  await claimOtpDispatchAttempt(reserved.dispatchId);
  const accepted=await recordOtpDispatchAcknowledgement(reserved.dispatchId,uid);
  assert.equal(accepted.status,"ACKNOWLEDGED");
  assert.equal(accepted.providerUid,uid);
  assert.equal(accepted.otpVerified,false);
  assert.equal(accepted.sessionAuthorized,false);
  assert.equal(accepted.businessActivated,false);
  const delivered=await recordOtpDispatchDelivery(reserved.dispatchId,uid,"DELIVERED");
  assert.equal(delivered.status,"DELIVERED");
  assert.equal(delivered.otpVerified,false);
  assert.equal(delivered.businessActivated,false);
  const events=await rows(
    "SELECT event_type FROM otp_dispatch_events WHERE dispatch_id=?",[reserved.dispatchId]
  );
  assert.deepEqual(new Set(events.map(r=>r.event_type)),
    new Set(["RESERVED","SEND_CLAIMED","ACKNOWLEDGED","DELIVERED"]));
  await assert.rejects(()=>recordOtpDispatchDelivery(reserved.dispatchId,uid,"DELIVERED"),
    error("DISPATCH_STATE_CONFLICT"));
});
test("uncertain send cannot be silently reset or accepted twice",async()=>{
  const f=await fixture();
  const {dispatchId}=await reserveOtpDispatch(f);
  await claimOtpDispatchAttempt(dispatchId);
  const firstUid="uid_"+randomBytes(14).toString("hex");
  await recordOtpDispatchAcknowledgement(dispatchId,firstUid);
  await assert.rejects(
    ()=>recordOtpDispatchAcknowledgement(dispatchId,firstUid),
    error("DISPATCH_STATE_CONFLICT")
  );
  await assert.rejects(
    ()=>recordOtpDispatchDelivery(dispatchId,"uid_"+randomBytes(14).toString("hex"),"FAILED"),
    error("DISPATCH_STATE_CONFLICT")
  );
  const state=await rows("SELECT status,attempt_count,provider_uid FROM otp_dispatch_records WHERE id=?",
    [dispatchId]);
  assert.equal(state[0].status,"ACKNOWLEDGED");
  assert.equal(state[0].attempt_count,1);
  assert.equal(state[0].provider_uid,firstUid);
});
test("consumed OTP challenge cannot later be claimed for delivery",async()=>{
  const f=await fixture();
  const {dispatchId}=await reserveOtpDispatch(f);
  await db.execute("DELETE FROM otp_verifications WHERE id=?",[f.challengeId]);
  await assert.rejects(
    ()=>claimOtpDispatchAttempt(dispatchId),
    error("CHALLENGE_NOT_ACTIVE")
  );
  const state=await rows(
    "SELECT status,attempt_count FROM otp_dispatch_records WHERE id=?",
    [dispatchId]
  );
  assert.equal(state[0].status,"RESERVED");
  assert.equal(state[0].attempt_count,0);
});
test("two concurrent claims permit at most one send attempt",async()=>{
  const f=await fixture();
  const {dispatchId}=await reserveOtpDispatch(f);
  const result=await Promise.allSettled([
    claimOtpDispatchAttempt(dispatchId),claimOtpDispatchAttempt(dispatchId),
  ]);
  assert.equal(result.filter(x=>x.status==="fulfilled").length,1);
  const rowsResult=await rows(
    "SELECT attempt_count,status FROM otp_dispatch_records WHERE id=?",
    [dispatchId]
  );
  assert.equal(rowsResult[0].attempt_count,1);
  assert.equal(rowsResult[0].status,"DISPATCH_UNKNOWN");
});
test("production, disabled flags and missing CI marker reject before DB connection",async()=>{
  const f=await fixture();
  let calls=0;
  const unexpected=async():Promise<never>=>{
    calls++;throw new Error("UNEXPECTED_CONNECTION");
  };
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(()=>reserveOtpDispatch(f,unexpected),error("OTP_DISPATCH_DISABLED"));
    process.env.NODE_ENV="development";
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="false";
    await assert.rejects(()=>reserveOtpDispatch(f,unexpected),error("OTP_DISPATCH_DISABLED"));
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="true";
    process.env.NOTETO_CI_DISPOSABLE_DB="fake";
    await assert.rejects(()=>reserveOtpDispatch(f,unexpected),error("OTP_DISPATCH_DISABLED"));
  }finally{
    process.env.NODE_ENV="development";
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="true";
    process.env.NOTETO_CI_DISPOSABLE_DB="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE";
  }
  assert.equal(calls,0);
});
