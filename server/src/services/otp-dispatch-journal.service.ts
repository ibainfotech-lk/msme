/**
 * F.17.5i — durable OTP dispatch journal (DISPOSABLE CI ONLY).
 *
 * NO HTTP route, SMS transport, code generation, user authentication,
 * subscription activation or production startup wiring. Never store OTP
 * plaintext, message content, bearer tokens or raw phone numbers here.
 *
 * Crucial: The claimed state is DISPATCH_UNKNOWN before any attempted
 * provider operation, and no automated retry is permitted after a claim,
 * even if the process crashes or the provider times out.
 */
import {createHash,createHmac,randomUUID} from "node:crypto";
import type {PoolConnection,RowDataPacket} from "mysql2/promise";
import pool from "../config/database";

export type DispatchState=
  "RESERVED"|"DISPATCH_UNKNOWN"|"ACKNOWLEDGED"|"DELIVERED"|"FAILED";
type DispatchErrorCode=
  | "OTP_DISPATCH_DISABLED" | "INVALID_DISPATCH_REQUEST"
  | "CHALLENGE_NOT_ACTIVE" | "DISPATCH_KEY_CONFLICT"
  | "DISPATCH_ALREADY_ATTEMPTED" | "DISPATCH_NOT_FOUND"
  | "DISPATCH_STATE_CONFLICT" | "DISPATCH_PROVIDER_UID_INVALID"
  | "DISPOSABLE_DB_NOT_VERIFIED";
export class OtpDispatchJournalError extends Error {
  constructor(public readonly code:DispatchErrorCode){
    super(code);
    this.name="OtpDispatchJournalError";
  }
}
export interface ReserveDispatchInput{
  challengeId:string;
  phoneE164:string;
  idempotencyKey:string;
}
export interface DispatchSnapshot{
  dispatchId:string;
  challengeId:string;
  status:DispatchState;
  providerUid:string|null;
  attemptCount:number;
  replayed:boolean;
  /** These are never elevated based on a provider state. */
  otpVerified:false;
  sessionAuthorized:false;
  businessActivated:false;
}
interface JournalRow extends RowDataPacket {
  id:string;
  challenge_id:string;
  request_sha256:string;
  status:DispatchState;
  provider_uid:string|null;
  attempt_count:number;
  challenge_expires_at:Date;
}
interface ChallengeRow extends RowDataPacket{
  id:string;phone:string;expires_at:Date;is_active:number;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phone=/^\+947[0-9]{8}$/;
const key=/^[A-Za-z0-9_-]{16,100}$/;
const uid=/^[A-Za-z0-9_-]{8,128}$/;
type ConnectionFactory=()=>Promise<PoolConnection>;
const defaultConnection:ConnectionFactory=()=>pool.getConnection();
function denied(code:DispatchErrorCode):never {
  throw new OtpDispatchJournalError(code);
}
function gate():string{
  if(
    process.env.NODE_ENV!=="development" ||
    process.env.CI!=="true" ||
    process.env.GITHUB_ACTIONS!=="true" ||
    process.env.RUNNER_OS!=="Linux" ||
    process.env.GITHUB_REPOSITORY!=="ibainfotech-lk/msme" ||
    process.env.NOTETO_CI_DISPOSABLE_DB!=="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE" ||
    process.env.NOTETO_OTP_DISPATCH_CI_ENABLED!=="true" ||
    process.env.DB_HOST!=="127.0.0.1" ||
    process.env.DB_PORT!=="3307" ||
    process.env.DB_NAME!=="noteto_dev" ||
    process.env.DB_USER!=="noteto_services" ||
    process.env.DB_PASSWORD!=="ci_dummy_unused_password"
  )denied("OTP_DISPATCH_DISABLED");
  const secret=process.env.NOTETO_OTP_DISPATCH_TEST_HMAC_KEY;
  if(typeof secret!=="string"||secret.length<32)
    denied("OTP_DISPATCH_DISABLED");
  return secret;
}
function validate(input:ReserveDispatchInput){
  if(!input||!uuid.test(input.challengeId??"")||
     !phone.test(input.phoneE164??"")||
     !key.test(input.idempotencyKey??"")){
    denied("INVALID_DISPATCH_REQUEST");
  }
}
function fingerprint(secret:string,phoneE164:string):string{
  return createHmac("sha256",secret).update("otp-phone-v1\0"+phoneE164).digest("hex");
}
function requestDigest(id:string,phoneHash:string,keyValue:string):string {
  return createHash("sha256").update(
    "otp-dispatch-v1\0"+id+"\0"+phoneHash+"\0"+keyValue
  ).digest("hex");
}
function snapshot(r:JournalRow,replayed:boolean):DispatchSnapshot{
  return {
    dispatchId:r.id,challengeId:r.challenge_id,status:r.status,
    providerUid:r.provider_uid,attemptCount:Number(r.attempt_count),
    replayed,otpVerified:false,sessionAuthorized:false,
    businessActivated:false,
  };
}
async function verifyDisposable(connection:PoolConnection):Promise<void>{
  const [guard]=await connection.execute<(RowDataPacket & {token:string})[]>(
    "SELECT token FROM _noteto_ci_ephemeral_guard LIMIT 1"
  );
  if(guard[0]?.token!=="ONLY_THE_EPHEMERAL_MYSQL84_SERVICE")
    denied("DISPOSABLE_DB_NOT_VERIFIED");
  const [ident]=await connection.execute<(RowDataPacket & {
    db_name:string;port:number;version:string;
  })[]>("SELECT DATABASE() AS db_name, @@port AS port, VERSION() AS version");
  if(ident[0]?.db_name!=="noteto_dev" ||
     Number(ident[0]?.port)!==3307 ||
     !String(ident[0]?.version).startsWith("8.4."))
    denied("DISPOSABLE_DB_NOT_VERIFIED");
}
async function event(
  connection:PoolConnection,id:string,
  name:"RESERVED"|"SEND_CLAIMED"|"ACKNOWLEDGED"|"DELIVERED"|"FAILED",
  providerUid:string|null=null
):Promise<void>{
  await connection.execute(
    "INSERT INTO otp_dispatch_events "+
    "(id,dispatch_id,event_type,provider_uid) VALUES (?,?,?,?)",
    [randomUUID(),id,name,providerUid],
  );
}
async function lock(
  connection:PoolConnection,dispatchId:string
):Promise<JournalRow>{
  const [r]=await connection.execute<JournalRow[]>(
    "SELECT id,challenge_id,request_sha256,status,provider_uid,"+
    "attempt_count,challenge_expires_at FROM otp_dispatch_records "+
    "WHERE id=? FOR UPDATE",
    [dispatchId]
  );
  if(!r[0])denied("DISPATCH_NOT_FOUND");
  return r[0];
}

/**
 * Idempotently reserve a challenge for a single potential provider send.
 * The existing OTP challenge must exist and be unexpired.
 * This is a CI-only DB journal, not a send authorization.
 */
export async function reserveOtpDispatch(
  input:ReserveDispatchInput,
  connectionFactory:ConnectionFactory=defaultConnection
):Promise<DispatchSnapshot>{
  const secret=gate();
  validate(input);
  const phoneHash=fingerprint(secret,input.phoneE164);
  const hash=requestDigest(input.challengeId,phoneHash,input.idempotencyKey);
  const conn=await connectionFactory();
  try{
    await verifyDisposable(conn);
    await conn.beginTransaction();
    const [prior]=await conn.execute<JournalRow[]>(
      "SELECT id,challenge_id,request_sha256,status,provider_uid,"+
      "attempt_count,challenge_expires_at FROM otp_dispatch_records "+
      "WHERE request_key=? FOR UPDATE",[input.idempotencyKey]
    );
    if(prior[0]){
      if(prior[0].challenge_id!==input.challengeId ||
         prior[0].request_sha256!==hash)
        denied("DISPATCH_KEY_CONFLICT");
      await conn.commit();
      return snapshot(prior[0],true);
    }
    // Lock existing verification challenge before reserving a send. This
    // serializes competing reservations for the same challenge.
    const [challenges]=await conn.execute<ChallengeRow[]>(
      "SELECT id,phone,expires_at,"+
      "(expires_at>UTC_TIMESTAMP(3)) AS is_active "+
      "FROM otp_verifications WHERE id=? LIMIT 1 FOR UPDATE",
      [input.challengeId]
    );
    const challenge=challenges[0];
    if(!challenge||challenge.is_active!==1 ||
       challenge.phone!==input.phoneE164)
      denied("CHALLENGE_NOT_ACTIVE");
    const [other]=await conn.execute<JournalRow[]>(
      "SELECT id,challenge_id,request_sha256,status,provider_uid,"+
      "attempt_count,challenge_expires_at "+
      "FROM otp_dispatch_records WHERE challenge_id=? FOR UPDATE",
      [input.challengeId]
    );
    if(other[0])denied("DISPATCH_KEY_CONFLICT");
    const id=randomUUID();
    await conn.execute(
      "INSERT INTO otp_dispatch_records "+
      "(id,challenge_id,request_key,request_sha256,recipient_hmac_sha256,"+
      "challenge_expires_at) VALUES (?,?,?,?,?,?)",
      [id,input.challengeId,input.idempotencyKey,hash,phoneHash,
       challenge.expires_at]
    );
    await event(conn,id,"RESERVED");
    await conn.commit();
    return {
      dispatchId:id,challengeId:input.challengeId,status:"RESERVED",
      providerUid:null,attemptCount:0,replayed:false,
      otpVerified:false,sessionAuthorized:false,businessActivated:false,
    };
  }catch(e){
    try{await conn.rollback();}catch{/* do not override error */}
    throw e;
  }finally{conn.release();}
}

/**
 * Exactly-once CLAIM before a possible provider send. Claim cannot be
 * reverted automatically: a crash or network timeout could have sent it.
 */
export async function claimOtpDispatchAttempt(
  dispatchId:string,
  connectionFactory:ConnectionFactory=defaultConnection
):Promise<DispatchSnapshot>{
  gate();
  if(!uuid.test(dispatchId??""))denied("INVALID_DISPATCH_REQUEST");
  const conn=await connectionFactory();
  try{
    await verifyDisposable(conn);
    await conn.beginTransaction();
    const r=await lock(conn,dispatchId);
    if(r.status!=="RESERVED"||Number(r.attempt_count)!==0)
      denied("DISPATCH_ALREADY_ATTEMPTED");
    const [check]=await conn.execute<(RowDataPacket & {live:number})[]>(
      "SELECT (challenge_expires_at>UTC_TIMESTAMP(3)) AS live "+
      "FROM otp_dispatch_records WHERE id=? FOR UPDATE",
      [dispatchId]
    );
    if(check[0]?.live!==1)denied("CHALLENGE_NOT_ACTIVE");
    await conn.execute(
      "UPDATE otp_dispatch_records SET status='DISPATCH_UNKNOWN',"+
      "attempt_count=1,attempted_at=UTC_TIMESTAMP(3),"+
      "updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [dispatchId]
    );
    await event(conn,dispatchId,"SEND_CLAIMED");
    await conn.commit();
    return {...snapshot(r,false),status:"DISPATCH_UNKNOWN",attemptCount:1};
  }catch(e){
    try{await conn.rollback();}catch{}
    throw e;
  }finally{conn.release();}
}

/**
 * CI-only receipt journal for a separately authenticated future provider
 * acknowledgement. This function DOES NOT verify the receipt or call e-SMS.
 */
export async function recordOtpDispatchAcknowledgement(
  dispatchId:string,providerUid:string,
  connectionFactory:ConnectionFactory=defaultConnection
):Promise<DispatchSnapshot>{
  gate();
  if(!uuid.test(dispatchId??"")||!uid.test(providerUid??""))
    denied("DISPATCH_PROVIDER_UID_INVALID");
  const conn=await connectionFactory();
  try{
    await verifyDisposable(conn);
    await conn.beginTransaction();
    const r=await lock(conn,dispatchId);
    if(r.status!=="DISPATCH_UNKNOWN"||Number(r.attempt_count)!==1)
      denied("DISPATCH_STATE_CONFLICT");
    await conn.execute(
      "UPDATE otp_dispatch_records SET status='ACKNOWLEDGED',"+
      "provider_uid=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [providerUid,dispatchId]
    );
    await event(conn,dispatchId,"ACKNOWLEDGED",providerUid);
    await conn.commit();
    return {...snapshot(r,false),status:"ACKNOWLEDGED",providerUid};
  }catch(e){
    try{await conn.rollback();}catch{}
    throw e;
  }finally{conn.release();}
}

/**
 * CI-only delivery status recording. Provider delivery is never OTP proof.
 * Requires independently checked UID in the *future* caller.
 */
export async function recordOtpDispatchDelivery(
  dispatchId:string,providerUid:string,
  outcome:"DELIVERED"|"FAILED",
  connectionFactory:ConnectionFactory=defaultConnection
):Promise<DispatchSnapshot>{
  gate();
  if(!uuid.test(dispatchId??"")||!uid.test(providerUid??"")||
     (outcome!=="DELIVERED"&&outcome!=="FAILED"))
    denied("INVALID_DISPATCH_REQUEST");
  const conn=await connectionFactory();
  try{
    await verifyDisposable(conn);
    await conn.beginTransaction();
    const r=await lock(conn,dispatchId);
    if(r.status!=="ACKNOWLEDGED"||r.provider_uid!==providerUid)
      denied("DISPATCH_STATE_CONFLICT");
    await conn.execute(
      "UPDATE otp_dispatch_records SET status=?,finalized_at=UTC_TIMESTAMP(3),"+
      "updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [outcome,dispatchId]
    );
    await event(conn,dispatchId,outcome,providerUid);
    await conn.commit();
    return {...snapshot(r,false),status:outcome};
  }catch(e){
    try{await conn.rollback();}catch{}
    throw e;
  }finally{conn.release();}
}
