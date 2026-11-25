import "dotenv/config";
import assert from "node:assert/strict";
import {randomBytes,randomInt,randomUUID} from "node:crypto";
import {after,before,test} from "node:test";
import mysql,{type RowDataPacket} from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  simulateOtpDispatchOnce,
  type SyntheticOtpSendPort,
  type SyntheticDispatchResult,
} from "../src/services/otp-dispatch-orchestration.ci";
import {OtpDispatchJournalError} from "../src/services/otp-dispatch-journal.service";

const disposable = process.env.CI==="true" &&
  process.env.GITHUB_ACTIONS==="true" &&
  process.env.RUNNER_OS==="Linux" &&
  process.env.GITHUB_REPOSITORY==="ibainfotech-lk/msme" &&
  process.env.NODE_ENV==="development" &&
  process.env.NOTETO_CI_DISPOSABLE_DB==="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" &&
  process.env.DB_HOST==="127.0.0.1" &&
  process.env.DB_PORT==="3307" &&
  process.env.DB_NAME==="noteto_dev" &&
  process.env.DB_USER==="noteto_services" &&
  process.env.DB_PASSWORD==="ci_dummy_unused_password";
if(!disposable) throw new Error("STOP: synthetic orchestration requires ephemeral GitHub MySQL 8.4.");
process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="true";
process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY=
  "noteto-disposable-ci-orchestration-key-not-for-production-123";

const db=mysql.createPool({
  host:"127.0.0.1",port:3307,database:"noteto_dev",
  user:"noteto_services",password:"ci_dummy_unused_password",
  timezone:"Z",connectionLimit:8,
});
after(async()=>{await db.end();await runtimePool.end();});
interface Row extends RowDataPacket {
  n?:number;status?:string;attempt_count?:number;
  provider_uid?:string|null;event_type?:string;
  token?:string;version?:string;
}
async function query(sql:string,params:unknown[]=[]):Promise<Row[]> {
  const [rows]=await db.execute<Row[]>(sql,params);
  return rows;
}
before(async()=>{
  const guard=await query("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guard[0]?.token,"ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const v=await query("SELECT VERSION() AS version");
  assert.match(String(v[0]?.version),/^8\.4\./);
  const m=await query(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  assert.equal(Number(m[0]?.n),25);
});
async function fixture(){
  const challengeId=randomUUID();
  const phoneE164="+9477"+String(randomInt(0,10_000_000)).padStart(7,"0");
  await db.execute(
    "INSERT INTO otp_verifications (id,phone,otp_hash,attempts,expires_at) "+
    "VALUES (?,?,?,0,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE))",
    [challengeId,phoneE164,"synthetic-hash-not-a-usable-otp"]
  );
  return {
    challengeId,phoneE164,
    idempotencyKey:"ci_orch_"+randomBytes(18).toString("hex"),
  };
}
function accepted(uid:string):ReturnType<SyntheticOtpSendPort["send"]>{
  return Promise.resolve({
    outcome:"ACCEPTED_NOT_DELIVERED",providerUid:uid,
    permitsOtpVerification:false,userAuthenticated:false,businessActivated:false,
  });
}
function neverAuthorized(result:SyntheticDispatchResult){
  assert.equal(result.resendPermitted,false);
  assert.equal(result.otpVerified,false);
  assert.equal(result.sessionAuthorized,false);
  assert.equal(result.businessActivated,false);
  assert.equal(JSON.stringify(result).includes("9477"),false);
  assert.equal(JSON.stringify(result).includes("NOTETO DISPOSABLE"),false);
}
test("one claimed dispatch records provider accepted UID without authenticating",async()=>{
  const f=await fixture();
  const uid="uid_"+randomBytes(12).toString("hex");
  let calls=0;
  const transport:SyntheticOtpSendPort={send:async input=>{
    calls++;
    assert.equal(input.phoneE164,f.phoneE164);
    assert.equal(input.message,"NOTETO DISPOSABLE CI MESSAGE - NOT A VALID OTP");
    assert.equal(input.syntheticRecipientAuthorized,true);
    return accepted(uid);
  }};
  const result=await simulateOtpDispatchOnce(f,transport);
  assert.equal(result.outcome,"PROVIDER_ACCEPTED_NOT_DELIVERED");
  assert.equal(result.portInvoked,true);
  assert.equal(result.providerUid,uid);
  assert.equal(calls,1);
  neverAuthorized(result);
  const state=await query(
    "SELECT status,attempt_count,provider_uid "+
    "FROM otp_dispatch_records WHERE id=?",[result.dispatchId]
  );
  assert.equal(state[0]?.status,"ACKNOWLEDGED");
  assert.equal(state[0]?.attempt_count,1);
  assert.equal(state[0]?.provider_uid,uid);
  const events=await query(
    "SELECT event_type FROM otp_dispatch_events WHERE dispatch_id=?",
    [result.dispatchId]
  );
  assert.deepEqual(new Set(events.map(r=>r.event_type)),
    new Set(["RESERVED","SEND_CLAIMED","ACKNOWLEDGED"]));
  const replay=await simulateOtpDispatchOnce(f,transport);
  assert.equal(replay.outcome,"REPLAY_NO_SEND");
  assert.equal(replay.portInvoked,false);
  assert.equal(replay.dispatchId,result.dispatchId);
  assert.equal(calls,1);
  neverAuthorized(replay);
});
test("unknown transport outcome remains irreversible and cannot auto-resend",async()=>{
  const f=await fixture();
  let calls=0;
  const port:SyntheticOtpSendPort={async send(){
    calls++;throw new Error("SYNTHETIC PRIVATE ERROR 94771234567");
  }};
  const first=await simulateOtpDispatchOnce(f,port);
  assert.equal(first.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(first.portInvoked,true);
  neverAuthorized(first);
  const replay=await simulateOtpDispatchOnce(f,port);
  assert.equal(replay.outcome,"REPLAY_NO_SEND");
  assert.equal(calls,1);
  const state=await query(
    "SELECT status,attempt_count FROM otp_dispatch_records WHERE id=?",
    [first.dispatchId]
  );
  assert.equal(state[0]?.status,"DISPATCH_UNKNOWN");
  assert.equal(state[0]?.attempt_count,1);
});
test("provider rejection never causes an automatic send retry",async()=>{
  const f=await fixture();
  let calls=0;
  const port:SyntheticOtpSendPort={async send(){
    calls++;
    return {
      outcome:"REJECTED",reason:"PROVIDER_DECLINED",
      permitsOtpVerification:false,userAuthenticated:false,businessActivated:false,
    };
  }};
  const first=await simulateOtpDispatchOnce(f,port);
  assert.equal(first.outcome,"RECONCILIATION_REQUIRED");
  neverAuthorized(first);
  const second=await simulateOtpDispatchOnce(f,port);
  assert.equal(second.outcome,"REPLAY_NO_SEND");
  assert.equal(calls,1);
});
test("second key against same challenge never sends again",async()=>{
  const f=await fixture();
  let calls=0;
  const port:SyntheticOtpSendPort={async send(){
    calls++;
    return accepted("uid_"+randomBytes(12).toString("hex"));
  }};
  const first=await simulateOtpDispatchOnce(f,port);
  assert.equal(first.outcome,"PROVIDER_ACCEPTED_NOT_DELIVERED");
  await assert.rejects(
    ()=>simulateOtpDispatchOnce({
      ...f,idempotencyKey:"different_"+randomBytes(18).toString("hex"),
    },port),
    (e:unknown)=>e instanceof OtpDispatchJournalError&&
      e.code==="DISPATCH_KEY_CONFLICT",
  );
  assert.equal(calls,1);
});
test("two concurrent requests with the same key permit at most one invocation",async()=>{
  const f=await fixture();
  let calls=0;
  const port:SyntheticOtpSendPort={async send(){
    calls++;
    return accepted("uid_"+randomBytes(12).toString("hex"));
  }};
  const settled=await Promise.allSettled([
    simulateOtpDispatchOnce(f,port),simulateOtpDispatchOnce(f,port),
  ]);
  assert.equal(calls,1);
  assert.equal(settled.filter(r=>r.status==="fulfilled" &&
    r.value.outcome==="PROVIDER_ACCEPTED_NOT_DELIVERED").length,1);
  const rows=await query(
    "SELECT COUNT(*) AS n FROM otp_dispatch_records WHERE challenge_id=?",
    [f.challengeId]
  );
  assert.equal(Number(rows[0]?.n),1);
});
test("disabled CI boundary refuses without calling even a fake transport",async()=>{
  const f=await fixture();
  let calls=0;
  const port:SyntheticOtpSendPort={async send(){
    calls++;return accepted("uid_"+randomBytes(12).toString("hex"));
  }};
  const current=process.env.NODE_ENV;
  const ciFlag=process.env.NOTETO_OTP_DISPATCH_CI_ENABLED;
  try {
    process.env.NODE_ENV="production";
    const blocked=await simulateOtpDispatchOnce(f,port);
    assert.equal(blocked.outcome,"CI_DISABLED");
    assert.equal(blocked.dispatchId,null);
    assert.equal(blocked.portInvoked,false);
    neverAuthorized(blocked);
    process.env.NODE_ENV=current;
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="false";
    assert.equal((await simulateOtpDispatchOnce(f,port)).outcome,"CI_DISABLED");
  }finally{
    process.env.NODE_ENV=current;
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED=ciFlag;
  }
  assert.equal(calls,0);
});
