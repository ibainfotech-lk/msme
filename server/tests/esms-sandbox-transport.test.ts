import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEsmsSandboxTransport,
  type EsmsSandboxConfig,
  type EsmsOutboundHttpRequest,
  type EsmsHttpExecutor,
} from "../src/services/esms-sandbox-transport";

const cfg:EsmsSandboxConfig={
  stage:"STAGING",senderId:"NOTETO",
  bearerToken:"synthetic-placeholder-value",
  sandboxAccountApproved:true,senderIdApproved:true,
  providerCredentialScoped:true,
};
const sendInput={phoneE164:"+94712345678",
  message:"Synthetic code 123456",syntheticRecipientAuthorized:true};
const uid="a91f3c7d2e04";
function stub(data:unknown,status=200){
  const calls:EsmsOutboundHttpRequest[]=[];
  const executor:EsmsHttpExecutor={async execute(req){
    calls.push(req);return {data,status};
  }};
  return {executor,calls};
}
test("staging uses a fixed JSON HTTPS POST with injectable fake executor",async()=>{
  const f=stub({status:"success",data:{
    uid,to:"94712345678",from:"NOTETO",uids:[uid],
  }});
  const result=await createEsmsSandboxTransport(cfg,f.executor).send(sendInput);
  assert.equal(result.outcome,"ACCEPTED_NOT_DELIVERED");
  assert.equal(result.userAuthenticated,false);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,"https://e-sms.lk/api/v3/sms/send");
  assert.equal(f.calls[0].method,"POST");
  assert.equal(f.calls[0].redirect,"error");
  assert.equal(f.calls[0].timeoutMs,5000);
  assert.equal(f.calls[0].maxResponseBytes,8192);
  assert.deepEqual(JSON.parse(f.calls[0].body!),{
    recipient:"94712345678",sender_id:"NOTETO",message:sendInput.message,
  });
});
test("production, CI, missing approvals or invalid credentials make no calls",async()=>{
  const variants:EsmsSandboxConfig[]=[
    {...cfg,stage:"PRODUCTION"},{...cfg,stage:"DISPOSABLE_CI"},
    {...cfg,sandboxAccountApproved:false},
    {...cfg,senderIdApproved:false},
    {...cfg,providerCredentialScoped:false},
    {...cfg,bearerToken:"invalid"},
  ];
  for(const config of variants){
    const f=stub({status:"success",data:{uid}});
    const result=await createEsmsSandboxTransport(config,f.executor).send(sendInput);
    assert.equal(result.outcome,"SANDBOX_DISABLED");
    assert.equal(f.calls.length,0);
  }
});
test("invalid or unapproved SMS target cannot call executor",async()=>{
  for(const candidate of [
    {...sendInput,syntheticRecipientAuthorized:false},
    {...sendInput,phoneE164:"+447123456789"},
    {...sendInput,message:""},
  ]){
    const f=stub({status:"success",data:{uid}});
    const result=await createEsmsSandboxTransport(cfg,f.executor).send(candidate);
    assert.equal(result.outcome,"SANDBOX_DISABLED");
    assert.equal(f.calls.length,0);
  }
});
test("mismatched response metadata is uncertain, with no verification",async()=>{
  const f=stub({status:"success",data:{
    uid,to:"94770000000",from:"NOTETO",
  }});
  const result=await createEsmsSandboxTransport(cfg,f.executor).send(sendInput);
  assert.equal(result.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(result.userAuthenticated,false);
  assert.equal(f.calls.length,1);
});
test("a transport exception never triggers retry or leaks its message",async()=>{
  let calls=0;
  const executor:EsmsHttpExecutor={async execute(){
    calls++;throw new Error("synthetic request failed");
  }};
  const result=await createEsmsSandboxTransport(cfg,executor).send(sendInput);
  assert.equal(result.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes("synthetic request failed"),false);
});
test("HTTP errors are classified without authenticating anyone",async()=>{
  for(const [http,code,outcome] of [
    [401,"UNAUTHENTICATED","REJECTED"],
    [422,"SENDER_NOT_APPROVED","REJECTED"],
    [429,"RATE_LIMITED","RECONCILIATION_REQUIRED"],
    [503,"NETWORK_BUSY","RECONCILIATION_REQUIRED"],
  ] as const){
    const f=stub({status:"error",code},http);
    const result=await createEsmsSandboxTransport(cfg,f.executor).send(sendInput);
    assert.equal(result.outcome,outcome);
    assert.equal(result.userAuthenticated,false);
  }
});
