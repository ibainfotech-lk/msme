import "dotenv/config";
import assert from "node:assert/strict";
import {randomBytes,randomInt} from "node:crypto";
import {after,before,test} from "node:test";
import mysql,{type PoolConnection,type RowDataPacket} from "mysql2/promise";
import runtimePool from "../src/config/database";
import {
  createReservedOtpChallengeInDisposableCi,
  OtpDispatchJournalError,
} from "../src/services/otp-dispatch-journal.service";

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
if(!disposable)throw new Error("STOP: atomic OTP test requires disposable GitHub Actions MySQL.");
process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="true";
process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY=
  "noteto-disposable-only-atomic-otp-binding-fake-secret-123";

const db=mysql.createPool({
  host:"127.0.0.1",port:3307,user:"noteto_services",
  password:"ci_dummy_unused_password",database:"noteto_dev",
  timezone:"Z",connectionLimit:8,
});
after(async()=>{await db.end();await runtimePool.end();});
interface Row extends RowDataPacket{
  n?:number;
  id?:string;
  challenge_id?:string;
  request_key?:string;
  phone?:string;
  otp_hash?:string;
  status?:string;
  attempt_count?:number;
  recipient_hmac_sha256?:string;
  request_sha256?:string;
  event_type?:string;
  expires_at?:Date;
  token?:string;
}
async function rows(sql:string,values:unknown[]=[]):Promise<Row[]>{
  const [r]=await db.execute<Row[]>(sql,values);
  return r;
}
function request(){
  const phoneE164="+9477"+String(randomInt(0,10_000_000)).padStart(7,"0");
  return {
    phoneE164,
    idempotencyKey:"ci_atomic_"+randomBytes(20).toString("hex"),
  };
}
function expectedError(code:string){
  return (e:unknown)=>{
    assert.ok(e instanceof OtpDispatchJournalError);
    assert.equal(e.code,code);
    return true;
  };
}
before(async()=>{
  const guard=await rows("SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1");
  assert.equal(guard[0]?.token,"ONLY_THE_EPHEMERAL_MYSQL84_SERVICE");
  const [identity]=await db.execute<(RowDataPacket & {
    db_name:string;version:string;
  })[]>("SELECT DATABASE() AS db_name,VERSION() AS version");
  assert.equal(identity[0]?.db_name,"noteto_dev");
  assert.match(String(identity[0]?.version),/^8\.4\./);
  const migrations=await rows(
    "SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL"
  );
  assert.equal(Number(migrations[0]?.n),25);
});
test("creates hashed challenge, dispatch and RESERVED event together",async()=>{
  const input=request();
  const output=await createReservedOtpChallengeInDisposableCi(input);
  assert.equal(output.status,"RESERVED");
  assert.equal(output.attemptCount,0);
  assert.equal(output.replayed,false);
  assert.equal(output.otpVerified,false);
  assert.equal(output.businessActivated,false);
  for(const prop of ["otp","otpCode","message","phoneE164","bearerToken"]){
    assert.equal(Object.hasOwn(output,prop),false);
  }
  const active=await rows(
    "SELECT id,phone,otp_hash,expires_at FROM otp_verifications WHERE id=?",
    [output.challengeId]
  );
  assert.equal(active.length,1);
  assert.equal(active[0]?.phone,input.phoneE164);
  assert.match(active[0]?.otp_hash??"",/^\$2[aby]\$12\$/);
  const journal=await rows(
    "SELECT challenge_id,request_key,status,attempt_count,"+
    "recipient_hmac_sha256,request_sha256 FROM otp_dispatch_records WHERE id=?",
    [output.dispatchId]
  );
  assert.equal(journal.length,1);
  assert.equal(journal[0]?.challenge_id,output.challengeId);
  assert.equal(journal[0]?.status,"RESERVED");
  assert.equal(journal[0]?.attempt_count,0);
  assert.equal(journal[0]?.request_key,input.idempotencyKey);
  assert.match(journal[0]?.recipient_hmac_sha256??"",/^[a-f0-9]{64}$/);
  assert.match(journal[0]?.request_sha256??"",/^[a-f0-9]{64}$/);
  const events=await rows(
    "SELECT event_type FROM otp_dispatch_events WHERE dispatch_id=?",
    [output.dispatchId]
  );
  assert.deepEqual(events.map(e=>e.event_type),["RESERVED"]);
});
test("exact key replay returns original IDs, never generates a new OTP",async()=>{
  const input=request();
  const first=await createReservedOtpChallengeInDisposableCi(input);
  const second=await createReservedOtpChallengeInDisposableCi(input);
  assert.equal(second.replayed,true);
  assert.equal(second.dispatchId,first.dispatchId);
  assert.equal(second.challengeId,first.challengeId);
  assert.equal(second.otpVerified,false);
  const count=await rows(
    "SELECT COUNT(*) AS n FROM otp_dispatch_records WHERE request_key=?",
    [input.idempotencyKey]
  );
  assert.equal(Number(count[0]?.n),1);
});
test("same key with different recipient fails rather than binding wrong phone",async()=>{
  const input=request();
  await createReservedOtpChallengeInDisposableCi(input);
  await assert.rejects(
    ()=>createReservedOtpChallengeInDisposableCi({
      ...input,phoneE164:"+94770000000",
    }),
    expectedError("DISPATCH_KEY_CONFLICT")
  );
});
test("an active phone cannot obtain a second challenge under a new key",async()=>{
  const input=request();
  const original=await createReservedOtpChallengeInDisposableCi(input);
  await assert.rejects(
    ()=>createReservedOtpChallengeInDisposableCi({
      phoneE164:input.phoneE164,
      idempotencyKey:"ci_other_"+randomBytes(20).toString("hex"),
    }),
    expectedError("CHALLENGE_ALREADY_ACTIVE")
  );
  const count=await rows(
    "SELECT COUNT(*) AS n FROM otp_dispatch_records WHERE challenge_id=?",
    [original.challengeId]
  );
  assert.equal(Number(count[0]?.n),1);
});
test("expired challenge may be replaced with a new key while preserving old journal",async()=>{
  const input=request();
  const old=await createReservedOtpChallengeInDisposableCi(input);
  await db.execute(
    "UPDATE otp_verifications SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",
    [old.challengeId]
  );
  const updated=await createReservedOtpChallengeInDisposableCi({
    phoneE164:input.phoneE164,
    idempotencyKey:"ci_new_"+randomBytes(20).toString("hex"),
  });
  assert.notEqual(updated.challengeId,old.challengeId);
  assert.notEqual(updated.dispatchId,old.dispatchId);
  const live=await rows(
    "SELECT id FROM otp_verifications WHERE phone=?",[input.phoneE164]
  );
  assert.equal(live.length,1);
  assert.equal(live[0].id,updated.challengeId);
  const audit=await rows(
    "SELECT id FROM otp_dispatch_records WHERE id=?",[old.dispatchId]
  );
  assert.equal(audit.length,1);
});
test("consumed challenge key cannot resurrect a verification code",async()=>{
  const input=request();
  const first=await createReservedOtpChallengeInDisposableCi(input);
  await db.execute("DELETE FROM otp_verifications WHERE id=?",[first.challengeId]);
  await assert.rejects(
    ()=>createReservedOtpChallengeInDisposableCi(input),
    expectedError("CHALLENGE_NOT_ACTIVE")
  );
  const count=await rows(
    "SELECT COUNT(*) AS n FROM otp_verifications WHERE phone=?",
    [input.phoneE164]
  );
  assert.equal(Number(count[0]?.n),0);
});
test("two competing keys for same phone permit no more than one active challenge",async()=>{
  const f=request();
  const a=f;
  const b={...f,idempotencyKey:"ci_parallel_"+randomBytes(20).toString("hex")};
  const outcomes=await Promise.allSettled([
    createReservedOtpChallengeInDisposableCi(a),
    createReservedOtpChallengeInDisposableCi(b),
  ]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  const challenges=await rows(
    "SELECT COUNT(*) AS n FROM otp_verifications WHERE phone=?",[f.phoneE164]
  );
  assert.equal(Number(challenges[0]?.n),1);
});
test("event insert failure rolls back BOTH newly inserted tables",async()=>{
  const input=request();
  const connectionFactory=async():Promise<PoolConnection>=>{
    const raw=await runtimePool.getConnection();
    return new Proxy(raw,{
      get(target,prop){
        if(prop==="execute"){
          return (sql:string,values?:unknown[])=>{
            if(sql.includes("INSERT INTO otp_dispatch_events")){
              return Promise.reject(new Error("SYNTHETIC_EVENT_INSERT_FAILURE"));
            }
            return target.execute(sql,values);
          };
        }
        const value=Reflect.get(target,prop,target);
        return typeof value==="function"?value.bind(target):value;
      },
    }) as PoolConnection;
  };
  await assert.rejects(
    ()=>createReservedOtpChallengeInDisposableCi(input,connectionFactory),
    /SYNTHETIC_EVENT_INSERT_FAILURE/
  );
  const challenge=await rows(
    "SELECT id FROM otp_verifications WHERE phone=?",[input.phoneE164]
  );
  assert.equal(challenge.length,0);
  const journal=await rows(
    "SELECT id FROM otp_dispatch_records WHERE request_key=?",
    [input.idempotencyKey]
  );
  assert.equal(journal.length,0);
});
test("production and missing CI flag reject before acquiring a DB connection",async()=>{
  const input=request();
  let connected=0;
  const forbidden=async():Promise<never>=>{
    connected++;throw new Error("UNEXPECTED_DB_CONNECT");
  };
  const env=process.env.NODE_ENV;
  const flag=process.env.NOTETO_OTP_DISPATCH_CI_ENABLED;
  try{
    process.env.NODE_ENV="production";
    await assert.rejects(
      ()=>createReservedOtpChallengeInDisposableCi(input,forbidden),
      expectedError("OTP_DISPATCH_DISABLED")
    );
    process.env.NODE_ENV=env;
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED="false";
    await assert.rejects(
      ()=>createReservedOtpChallengeInDisposableCi(input,forbidden),
      expectedError("OTP_DISPATCH_DISABLED")
    );
  }finally{
    process.env.NODE_ENV=env;
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED=flag;
  }
  assert.equal(connected,0);
});
