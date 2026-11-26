import "dotenv/config";
import assert from "node:assert/strict";
import {randomBytes,randomInt} from "node:crypto";
import {after,before,test} from "node:test";
import bcrypt from "bcryptjs";
import mysql,{type RowDataPacket} from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  createReservedOtpChallengeInDisposableCi,
  exerciseEphemeralOtpHandoffInDisposableCi,
  type CiOtpEphemeralPort,
  type CiOtpHandoffResult,
  OtpDispatchJournalError,
} from "../src/services/otp-dispatch-journal.service";
import {verifyOtpChallenge} from "../src/services/otp.service";

const disposable=process.env.CI==="true" &&
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
if(!disposable)throw new Error("STOP: ephemeral OTP handoff test needs disposable CI MySQL.");
process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="true";
process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY=
  "noteto-ci-fake-handoff-secret-just-for-disposable-tests-123";
const db=mysql.createPool({
  host:"127.0.0.1",port:3307,database:"noteto_dev",
  user:"noteto_services",password:"ci_dummy_unused_password",
  timezone:"Z",connectionLimit:8,
});
after(async()=>{await db.end();await runtimePool.end();});
interface Row extends RowDataPacket {
  n?:number;
  id?:string;
  phone?:string;
  otp_hash?:string;
  status?:string;
  attempt_count?:number;
  provider_uid?:string;
  event_type?:string;
  token?:string;
}
async function query(sql:string,params:unknown[]=[]):Promise<Row[]>{
  const [r]=await db.execute<Row[]>(sql,params);return r;
}
function request(){
  return {
    phoneE164:"+9477"+String(randomInt(0,10_000_000)).padStart(7,"0"),
    idempotencyKey:"ci_handoff_"+randomBytes(20).toString("hex"),
  };
}
function fakeUid(){
  return "uid_"+randomBytes(15).toString("hex");
}
function noSecrets(out:CiOtpHandoffResult,secret?:string) {
  assert.equal(out.resendPermitted,false);
  assert.equal(out.otpVerified,false);
  assert.equal(out.sessionAuthorized,false);
  assert.equal(out.businessActivated,false);
  for(const field of ["otpCode","phoneE164","message","token","password"])
    assert.equal(Object.hasOwn(out,field),false);
  if(secret) assert.equal(JSON.stringify(out).includes(secret),false);
}
before(async()=>{
  const guard=await query("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guard[0]?.token,"ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const [id]=await db.execute<(RowDataPacket&{version:string})[]>(
    "SELECT VERSION() AS version"
  );
  assert.match(String(id[0]?.version),/^8\.4\./);
  const m=await query(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  assert.equal(Number(m[0]?.n),25);
});
test("ephemeral six-digit code matches committed hash; response never contains code",async()=>{
  const req=request();
  let invocations=0;
  let observedCode="";
  const port:CiOtpEphemeralPort={async deliver(msg){
    invocations++;
    observedCode=msg.otpCode; // CI TEST MEMORY ONLY, NEVER LOGGED
    assert.equal(msg.phoneE164,req.phoneE164);
    assert.match(msg.otpCode,/^[0-9]{6}$/);
    const challenges=await query(
      "SELECT otp_hash FROM otp_verifications WHERE phone=?",
      [req.phoneE164]
    );
    assert.equal(challenges.length,1);
    assert.equal(await bcrypt.compare(msg.otpCode,challenges[0].otp_hash??""),true);
    const state=await query(
      "SELECT status,attempt_count FROM otp_dispatch_records WHERE id=?",
      [msg.dispatchId]
    );
    assert.equal(state[0]?.status,"DISPATCH_UNKNOWN");
    assert.equal(state[0]?.attempt_count,1);
    return {status:"ACCEPTED",uid:fakeUid()};
  }};
  const r=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  assert.equal(invocations,1);
  assert.equal(r.outcome,"ACCEPTED_NOT_DELIVERED");
  assert.equal(r.fakePortInvoked,true);
  assert.equal(r.providerUid?.startsWith("uid_"),true);
  noSecrets(r,observedCode);
  const events=await query(
    "SELECT event_type FROM otp_dispatch_events WHERE dispatch_id=?",
    [r.dispatchId]
  );
  assert.deepEqual(new Set(events.map(x=>x.event_type)),
    new Set(["RESERVED","SEND_CLAIMED","ACKNOWLEDGED"]));
  const row=await query(
    "SELECT otp_hash FROM otp_verifications WHERE id=?",[r.challengeId]
  );
  assert.equal((row[0]?.otp_hash??"").includes(observedCode),false);
});
test("exact idempotency replay cannot invoke port or regenerate OTP",async()=>{
  const req=request();
  let invocations=0;
  const port:CiOtpEphemeralPort={async deliver(){
    invocations++;
    return {status:"ACCEPTED",uid:fakeUid()};
  }};
  const first=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  const replay=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  assert.equal(first.outcome,"ACCEPTED_NOT_DELIVERED");
  assert.equal(replay.outcome,"REPLAY_NO_SEND");
  assert.equal(replay.dispatchId,first.dispatchId);
  assert.equal(replay.challengeId,first.challengeId);
  assert.equal(replay.fakePortInvoked,false);
  assert.equal(invocations,1);
  noSecrets(replay);
});
test("existing reserved challenge is a replay and its discarded code is not revived",async()=>{
  const req=request();
  const reserved=await createReservedOtpChallengeInDisposableCi(req);
  let calls=0;
  const port:CiOtpEphemeralPort={async deliver(){
    calls++;return {status:"ACCEPTED",uid:fakeUid()};
  }};
  const r=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  assert.equal(r.outcome,"REPLAY_NO_SEND");
  assert.equal(r.dispatchId,reserved.dispatchId);
  assert.equal(calls,0);
  noSecrets(r);
});
test("transport throws; journal stays unknown and replay never sends again",async()=>{
  const req=request();
  let calls=0;
  const port:CiOtpEphemeralPort={async deliver(){
    calls++;
    throw new Error("simulated sensitive provider failure");
  }};
  const result=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  assert.equal(result.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(result.fakePortInvoked,true);
  noSecrets(result);
  const row=await query(
    "SELECT status,attempt_count FROM otp_dispatch_records WHERE id=?",
    [result.dispatchId]
  );
  assert.equal(row[0]?.status,"DISPATCH_UNKNOWN");
  assert.equal(row[0]?.attempt_count,1);
  const replay=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  assert.equal(replay.outcome,"REPLAY_NO_SEND");
  assert.equal(calls,1);
});
test("provider rejects or gives invalid UID: no verification or automatic retry",async()=>{
  const failureReq=request();
  const rejected=await exerciseEphemeralOtpHandoffInDisposableCi(
    failureReq,{async deliver(){return {status:"REJECTED"};}}
  );
  assert.equal(rejected.outcome,"RECONCILIATION_REQUIRED");
  noSecrets(rejected);
  const badUidReq=request();
  const badUid=await exerciseEphemeralOtpHandoffInDisposableCi(
    badUidReq,{async deliver(){return {status:"ACCEPTED",uid:"bad"};}}
  );
  assert.equal(badUid.outcome,"RECONCILIATION_REQUIRED");
  noSecrets(badUid);
  const prior=await query(
    "SELECT status,attempt_count FROM otp_dispatch_records WHERE id=?",
    [badUid.dispatchId]
  );
  assert.equal(prior[0]?.status,"DISPATCH_UNKNOWN");
  assert.equal(prior[0]?.attempt_count,1);
});
test("the emitted code can be consumed once by existing verification service",async()=>{
  const req=request();
  let code="";
  const port:CiOtpEphemeralPort={async deliver(arg){
    code=arg.otpCode;return {status:"ACCEPTED",uid:fakeUid()};
  }};
  const result=await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  assert.equal(result.outcome,"ACCEPTED_NOT_DELIVERED");
  assert.match(code,/^[0-9]{6}$/);
  const first=await verifyOtpChallenge(req.phoneE164,code);
  assert.equal(first.success,true);
  const second=await verifyOtpChallenge(req.phoneE164,code);
  assert.equal(second.success,false);
  const audit=await query(
    "SELECT status FROM otp_dispatch_records WHERE id=?",
    [result.dispatchId]
  );
  assert.equal(audit.length,1);
  assert.equal(audit[0]?.status,"ACKNOWLEDGED");
  code="";
  noSecrets(result);
});
test("same phone, different key cannot get a second code while challenge active",async()=>{
  const req=request();
  let calls=0;
  const port:CiOtpEphemeralPort={async deliver(){
    calls++;return {status:"ACCEPTED",uid:fakeUid()};
  }};
  await exerciseEphemeralOtpHandoffInDisposableCi(req,port);
  await assert.rejects(
    ()=>exerciseEphemeralOtpHandoffInDisposableCi({
      ...req,idempotencyKey:"ci_second_"+randomBytes(20).toString("hex")
    },port),
    (err:unknown)=>err instanceof OtpDispatchJournalError &&
      err.code==="CHALLENGE_ALREADY_ACTIVE"
  );
  assert.equal(calls,1);
});
test("CI gate rejects before database or simulated sender are called",async()=>{
  const req=request();
  let calls=0;
  const port:CiOtpEphemeralPort={async deliver(){
    calls++;return {status:"ACCEPTED",uid:fakeUid()};
  }};
  const prev=process.env.NODE_ENV;
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(
      ()=>exerciseEphemeralOtpHandoffInDisposableCi(req,port),
      (e:unknown)=>e instanceof OtpDispatchJournalError&&
        e.code==="OTP_DISPATCH_DISABLED"
    );
  }finally{
    process.env.NODE_ENV=prev;
  }
  assert.equal(calls,0);
  const blocked=await exerciseEphemeralOtpHandoffInDisposableCi(
    request(),null as unknown as CiOtpEphemeralPort
  );
  assert.equal(blocked.outcome,"CI_DISABLED");
  noSecrets(blocked);
});
