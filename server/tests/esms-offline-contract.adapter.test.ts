import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ESMS_SEND_URL, prepareEsmsOtpRequest, interpretEsmsSendResponse,
} from "../src/services/esms-offline-contract.adapter";

const valid = {
  phoneE164:"+94712345678",
  senderId:"NOTETO",
  message:"Noteto test OTP code 123456. Expires in 5 min.",
};

test("builds documented e-SMS JSON payload but NEVER transmits",()=>{
  const req=prepareEsmsOtpRequest(valid);
  assert.equal(req.endpoint,ESMS_SEND_URL);
  assert.equal(req.method,"POST");
  assert.equal(req.headers.Accept,"application/json");
  assert.equal(req.headers["Content-Type"],"application/json");
  assert.equal(req.transportEnabled,false);
  assert.deepEqual(JSON.parse(req.body),{
    recipient:"94712345678",sender_id:"NOTETO",message:valid.message,
  });
  assert.equal("Authorization" in req.headers,false);
});
test("only one Sri Lankan mobile in canonical +94 notation is allowed",()=>{
  for(const phoneE164 of [
    "0712345678","94712345678","+94712345678,94770000000",
    "+447123456789","+9471234567"," +94712345678",
    "+9471234567890","",
  ]){
    assert.throws(()=>prepareEsmsOtpRequest({...valid,phoneE164}),
      /ESMS_INVALID_RECIPIENT/);
  }
});
test("sender name is validated and cannot inject SMS API fields",()=>{
  for(const senderId of [
    "", "INVALID SENDER", "LONGER_THAN_11",
    "NOTETO\nAuthorization: x", "<tag>", "NOTETO_",
  ]){
    assert.throws(()=>prepareEsmsOtpRequest({...valid,senderId}),
      /ESMS_INVALID_SENDER_NAME/);
  }
});
test("empty, overlong and control-character-bearing messages are denied",()=>{
  for(const message of ["", " ", "x".repeat(301),"otp\nsecond line",
    "otp\r", "otp\u0000"]){
    assert.throws(()=>prepareEsmsOtpRequest({...valid,message}),
      /ESMS_INVALID_MESSAGE/);
  }
});
test("Tamil and Sinhala messages are serialized as UTF-8 JSON",()=>{
  for(const message of [
    "உங்கள் Noteto சரிபார்ப்புக் குறியீடு 123456.",
    "ඔබගේ Noteto සත්‍යාපන කේතය 123456.",
  ]){
    const req=prepareEsmsOtpRequest({...valid,message});
    assert.equal(JSON.parse(req.body).message,message);
    assert.equal(req.transportEnabled,false);
  }
});
test("valid provider acceptance is metadata, NOT delivered or authenticated",()=>{
  const r=interpretEsmsSendResponse(200,{
    status:"success",data:{uid:"a91f3c7d2e04",status:"Queued"},
  });
  assert.equal(r.outcome,"ACCEPTED_NOT_DELIVERED");
  assert.equal(r.permitsOtpVerification,false);
  assert.equal(r.userAuthenticated,false);
  assert.equal(r.businessActivated,false);
  if(r.outcome==="ACCEPTED_NOT_DELIVERED")
    assert.equal(r.providerUid,"a91f3c7d2e04");
});
test("missing, malformed, inconsistent success receipts require reconciliation",()=>{
  for(const item of [
    [200,{status:"success",data:null}],
    [200,{status:"success",data:{uid:""}}],
    [200,{status:"success",data:{uid:"bad"}}],
    [200,{status:"success",data:{uid:"bad\nvalueid"}}],
    [401,{status:"success",data:{uid:"a91f3c7d2e04"}}],
    [200,{status:"other"}],
    [200,null],
    [0,{status:"success",data:{uid:"a91f3c7d2e04"}}],
  ] as const){
    const r=interpretEsmsSendResponse(item[0],item[1]);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(r.userAuthenticated,false);
    assert.equal(r.businessActivated,false);
  }
});
test("documented terminal errors never auto-retry or authenticate",()=>{
  const cases=[
    [401,"UNAUTHENTICATED"],[402,"INSUFFICIENT_CREDITS"],
    [422,"SENDER_NOT_APPROVED"],[422,"SENDER_NOT_ACTIVE"],
    [422,"NO_RECIPIENTS"],[422,"ALL_BLOCKED"],[422,"BLACKOUT"],
  ] as const;
  for(const [status,code] of cases){
    const r=interpretEsmsSendResponse(status,{
      status:"error",code,message:"sensitive provider message",
    });
    assert.equal(r.outcome,"REJECTED");
    assert.equal(r.userAuthenticated,false);
    assert.equal(r.businessActivated,false);
    assert.equal(JSON.stringify(r).includes("sensitive"),false);
  }
});
test("throttling, network faults and ambiguous failures require reconciliation",()=>{
  const cases=[
    [429,"RATE_LIMITED"],[503,"NETWORK_BUSY"],
    [500,"SERVER_ERROR"],[422,"SEND_FAILED"],
    [409,"UNKNOWN_PROVIDER_CODE"],
  ] as const;
  for(const [status,code] of cases){
    const r=interpretEsmsSendResponse(status,{status:"error",code});
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(r.userAuthenticated,false);
    assert.equal(r.businessActivated,false);
  }
});
test("status error encoded as HTTP 200 is never silently trusted",()=>{
  const r=interpretEsmsSendResponse(200,{
    status:"error",code:"UNAUTHENTICATED",
  });
  assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(r.permitsOtpVerification,false);
});
