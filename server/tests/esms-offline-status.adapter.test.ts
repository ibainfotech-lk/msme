import assert from "node:assert/strict";
import {test} from "node:test";
import {
  ESMS_STATUS_BASE, prepareEsmsStatusQuery, interpretEsmsStatusResponse,
  type EsmsStatus,
  type EsmsStatusAssessment,
} from "../src/services/esms-offline-status.adapter";

const uid="a91f3c7d2e04";
const expected={uid,recipient:"94712345678",senderId:"NOTETO"};
function payload(status:string, override:Record<string,unknown>={}):unknown {
  return {status:"success",data:{
    uid, to:"94712345678",from:"NOTETO",
    message:"PRIVATE SIMULATED OTP 123456",status,
    ...override,
  }};
}
function noAuthority(r:EsmsStatusAssessment) {
  assert.equal(r.permitsAutomaticResend,false);
  assert.equal(r.otpVerified,false);
  assert.equal(r.sessionAuthorized,false);
  assert.equal(r.businessActivated,false);
  assert.equal(JSON.stringify(r).includes("123456"),false);
  assert.equal(JSON.stringify(r).includes("94712345678"),false);
}

test("lookup builder is a fixed HTTPS GET and does not send or authenticate",()=>{
  const q=prepareEsmsStatusQuery(uid);
  assert.equal(q.url,ESMS_STATUS_BASE+uid);
  assert.equal(q.method,"GET");
  assert.equal(q.headers.Accept,"application/json");
  assert.equal(q.transportEnabled,false);
  assert.equal("Authorization" in q.headers,false);
});
test("UID validation prevents path traversal, query injection and arbitrary origin",()=>{
  for(const value of ["", "bad", "../private/abc", "ab/cd123456",
    "a91f3c7d2e04?phone=1", "https://example.org",
    "a91f3c7d2e04#frag", " a91f3c7d2e04",
    "x".repeat(129), "x\nrequest",
  ]){
    assert.throws(()=>prepareEsmsStatusQuery(value),
      /ESMS_INVALID_MESSAGE_UID/);
  }
});
test("scheduled, pending, queued and sent remain in transit without resend",()=>{
  for(const status of ["Scheduled","Pending","Queued","Sent"] as EsmsStatus[]){
    const r=interpretEsmsStatusResponse(200,payload(status),expected);
    assert.equal(r.outcome,"IN_TRANSIT");
    assert.equal(r.providerStatus,status);
    noAuthority(r);
  }
});
test("delivered is a transport receipt, never authentication",()=>{
  const r=interpretEsmsStatusResponse(200,payload("Delivered"),expected);
  assert.equal(r.outcome,"DELIVERED_NOT_VERIFIED");
  assert.equal(r.providerStatus,"Delivered");
  noAuthority(r);
});
test("terminal delivery failures cannot trigger unreviewed resends",()=>{
  for(const status of ["Undelivered","Failed","Rejected","Expired"] as EsmsStatus[]){
    const r=interpretEsmsStatusResponse(200,payload(status),expected);
    assert.equal(r.outcome,"FINAL_DELIVERY_FAILURE");
    assert.equal(r.providerStatus,status);
    noAuthority(r);
  }
});
test("provider metadata must bind exact UID and recipient and sender",()=>{
  for(const changed of [
    {uid:"b91f3c7d2e04"},
    {to:"94777777777"},
    {from:"UNKNOWN"},
    {uid:null},
    {to:null},
    {from:null},
  ]){
    const r=interpretEsmsStatusResponse(200,payload("Delivered",changed),expected);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(r.reason,"UNTRUSTED_OR_MISMATCHED_STATUS");
    noAuthority(r);
  }
});
test("invalid original expected bindings cannot be bypassed by provider payload",()=>{
  for(const changed of [
    {uid:"bad"}, {recipient:"0712345678"},
    {recipient:"94712345678,94777777777"},
    {senderId:"NOTETO\nInjected"},
  ]){
    const r=interpretEsmsStatusResponse(200,payload("Delivered"),{
      ...expected,...changed
    });
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    noAuthority(r);
  }
});
test("unexpected statuses and case changes fail closed",()=>{
  for(const status of ["delivered","Submitted","Unknown","", "Refunded"]){
    const r=interpretEsmsStatusResponse(200,payload(status),expected);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(r.reason,"PROVIDER_STATUS_UNKNOWN");
    noAuthority(r);
  }
});
test("malformed provider JSON, errors and inconsistent HTTP success fail closed",()=>{
  for(const [httpStatus,body] of [
    [200,null],[200,[]],[200,{status:"error",code:"NOT_FOUND"}],
    [201,{status:"success",data:[]}],
    [401,payload("Delivered")],[422,payload("Delivered")],
    [0,payload("Delivered")],
  ] as const){
    const r=interpretEsmsStatusResponse(httpStatus,body,expected);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    noAuthority(r);
  }
});
test("404, rate limits and server outages cannot be mistaken for no send",()=>{
  for(const status of [404,429,500,503]){
    const r=interpretEsmsStatusResponse(status,{
      status:"error",code:"NOT_FOUND"
    },expected);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(r.reason,"PROVIDER_LOOKUP_UNCERTAIN");
    noAuthority(r);
  }
});
