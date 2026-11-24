import assert from "node:assert/strict";
import {test} from "node:test";
import {
  createEsmsSandboxTransport,
  type EsmsSandboxConfig, type EsmsHttpExecutor,
  type EsmsOutboundHttpRequest,
} from "../src/services/esms-sandbox-transport";
const conf:EsmsSandboxConfig={
  stage:"STAGING",senderId:"NOTETO",
  bearerToken:"synthetic-placeholder-value",
  sandboxAccountApproved:true,senderIdApproved:true,
  providerCredentialScoped:true,
};
const uid="a91f3c7d2e04";
const expected={
  uid,recipient:"94712345678",senderId:"NOTETO",
  serverStoredDispatchAuthorized:true,
};
function stub(data:unknown,status=200){
  const calls:EsmsOutboundHttpRequest[]=[];
  const http:EsmsHttpExecutor={async execute(req){
    calls.push(req);return {status,data};
  }};
  return {http,calls};
}
function statusPayload(status:string){
  return {status:"success",data:{
    uid,to:"94712345678",from:"NOTETO",status,
    message:"Synthetic example - not a real OTP",
  }};
}
test("delivery status lookup uses fixed URL and cannot grant login",async()=>{
  const f=stub(statusPayload("Delivered"));
  const result=await createEsmsSandboxTransport(conf,f.http).lookup(expected);
  assert.equal(result.outcome,"DELIVERED_NOT_VERIFIED");
  assert.equal(result.otpVerified,false);
  assert.equal(result.sessionAuthorized,false);
  assert.equal(result.businessActivated,false);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].method,"GET");
  assert.equal(f.calls[0].body,undefined);
  assert.equal(f.calls[0].url,"https://e-sms.lk/api/v3/sms/"+uid);
  assert.equal(JSON.stringify(result).includes("Synthetic example"),false);
});
test("untrusted dispatch reference and wrong recipient or sender cannot query",async()=>{
  for(const val of [
    {...expected,serverStoredDispatchAuthorized:false},
    {...expected,uid:"../bad"},
    {...expected,recipient:"0712345678"},
    {...expected,senderId:"OTHER"},
  ]){
    const f=stub(statusPayload("Delivered"));
    const result=await createEsmsSandboxTransport(conf,f.http).lookup(val);
    assert.equal(result.outcome,"SANDBOX_DISABLED");
    assert.equal(f.calls.length,0);
  }
});
test("status lookup rejects production regardless of future credentials",async()=>{
  const f=stub(statusPayload("Delivered"));
  const result=await createEsmsSandboxTransport({
    ...conf,stage:"PRODUCTION",
  },f.http).lookup(expected);
  assert.equal(result.outcome,"SANDBOX_DISABLED");
  assert.equal(f.calls.length,0);
});
test("provider failed, missing, mismatched and unknown status never auto-resend",async()=>{
  const cases=[
    [200,statusPayload("Failed"),"FINAL_DELIVERY_FAILURE"],
    [200,statusPayload("Unrecognized"),"RECONCILIATION_REQUIRED"],
    [404,{status:"error",code:"NOT_FOUND"},"RECONCILIATION_REQUIRED"],
    [200,{status:"success",data:{
      uid,to:"94770000000",from:"NOTETO",status:"Delivered",
    }},"RECONCILIATION_REQUIRED"],
  ] as const;
  for(const [httpStatus,data,outcome] of cases){
    const f=stub(data,httpStatus);
    const r=await createEsmsSandboxTransport(conf,f.http).lookup(expected);
    assert.equal(r.outcome,outcome);
    assert.equal(r.permitsAutomaticResend,false);
    assert.equal(r.otpVerified,false);
  }
});
test("timeout/transport exception is sanitized and never retried",async()=>{
  let calls=0;
  const http:EsmsHttpExecutor={async execute(){
    calls++;throw new Error("test-only downstream timeout");
  }};
  const result=await createEsmsSandboxTransport(conf,http).lookup(expected);
  assert.equal(result.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(result.permitsAutomaticResend,false);
  assert.equal(JSON.stringify(result).includes("downstream timeout"),false);
  assert.equal(calls,1);
});
