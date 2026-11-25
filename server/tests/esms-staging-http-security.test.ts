import assert from "node:assert/strict";
import {test} from "node:test";
import {
  createEsmsStagingHttpExecutor,
  type EsmsInjectedFetch,
  type EsmsStagingExecutorSettings,
} from "../src/services/esms-staging-http-executor";
import {prepareEsmsOtpRequest} from "../src/services/esms-offline-contract.adapter";
import type {EsmsOutboundHttpRequest} from "../src/services/esms-sandbox-transport";

const settings:EsmsStagingExecutorSettings={
  stage:"STAGING",providerSandboxApproved:true,
  senderIdApproved:true,egressToProviderApproved:true,
  credentialsFromSecretManager:true,
  authorizedTestRecipients:["94712345678"],
  authorizedStatusUids:["a91f3c7d2e04"],
};
const fakeToken="synthetic-placeholder-value";
function request():EsmsOutboundHttpRequest{
  const p=prepareEsmsOtpRequest({
    phoneE164:"+94712345678",senderId:"NOTETO",
    message:"Example staging code 123456",
  });
  return {
    url:p.endpoint,method:"POST",
    headers:{...p.headers,Authorization:"Bearer "+fakeToken},
    body:p.body,redirect:"error",timeoutMs:5000,maxResponseBytes:8192,
  };
}
function response(url:string,body:string,headers?:Record<string,string>){
  const r=new Response(body,{
    status:200,headers:{"content-type":"application/json",...headers},
  });
  return {
    status:r.status,url,redirected:false,
    headers:r.headers,body:r.body,
  };
}
test("wrong HTTPS endpoint, method or forged headers are rejected before fetch",async()=>{
  let invoked=0;
  const fake:EsmsInjectedFetch=async url=>{
    invoked++;
    return response(url,'{"status":"success"}');
  };
  const original=request();
  const invalid:EsmsOutboundHttpRequest[]=[
    {...original,url:"https://example.org/api/v3/sms/send"},
    {...original,url:"http://e-sms.lk/api/v3/sms/send"},
    {...original,url:original.url+"?debug=1"},
    {...original,redirect:"follow" as "error"},
    {...original,timeoutMs:10000 as 5000},
    {...original,maxResponseBytes:999999 as 8192},
    {...original,headers:{...original.headers,Authorization:"Bearer invalid"}},
    {...original,headers:{...original.headers,"X-Extra":"true"}},
    {...original,headers:{...original.headers,Accept:"text/plain"}},
  ];
  for(const value of invalid){
    await assert.rejects(
      createEsmsStagingHttpExecutor(fake,settings).execute(value),
      /ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN/,
    );
  }
  assert.equal(invoked,0);
});
test("extra JSON fields, changed phone and unapproved sender never reach fetch",async()=>{
  let invoked=0;
  const fake:EsmsInjectedFetch=async url=>{
    invoked++;return response(url,'{"status":"success"}');
  };
  const original=request();
  const json=JSON.parse(original.body??"{}");
  for(const payload of [
    {...json,recipient:"94770000000"},
    {...json,recipient:"94712345678,94770000000"},
    {...json,sender_id:"OTHER"},
    {...json,admin:true},
    {...json,message:""},
  ]){
    const req={...original,body:JSON.stringify(payload)};
    await assert.rejects(
      createEsmsStagingHttpExecutor(fake,settings).execute(req),
      /ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN/,
    );
  }
  assert.equal(invoked,0);
});
test("large response body and forged content length are rejected safely",async()=>{
  const cases=[
    {body:JSON.stringify({status:"success",data:{text:"x".repeat(9000)}})},
    {body:'{"status":"success"}',headers:{"content-length":"900000"}},
    {body:'{"status":"success"}',headers:{"content-length":"not-a-number"}},
  ];
  for(const item of cases){
    const fake:EsmsInjectedFetch=async url=>
      response(url,item.body,item.headers);
    await assert.rejects(
      createEsmsStagingHttpExecutor(fake,settings).execute(request()),
      /ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN/,
    );
  }
});
test("invalid UTF-8 or malformed JSON never returns a success response",async()=>{
  const badJson:EsmsInjectedFetch=async url=>
    response(url,"{ invalid JSON");
  await assert.rejects(
    createEsmsStagingHttpExecutor(badJson,settings).execute(request()),
    /ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN/,
  );
});
test("transport exceptions are sanitized before reaching caller",async()=>{
  const fake:EsmsInjectedFetch=async ()=>{
    throw new Error("simulated upstream exception with private fields");
  };
  const executor=createEsmsStagingHttpExecutor(fake,settings);
  await assert.rejects(executor.execute(request()),error=>{
    assert.equal((error as Error).message,
      "ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN");
    assert.equal(JSON.stringify(error).includes("private fields"),false);
    return true;
  });
});

test("unresponsive fake transport reaches five-second deadline and aborts",async()=>{
  let attempts=0;
  let aborted=false;
  const hung:EsmsInjectedFetch=async (_url,init)=>{
    attempts++;
    init.signal.addEventListener("abort",()=>{aborted=true;},{once:true});
    return await new Promise<never>(()=>{/* synthetic hung transport */});
  };
  const start=Date.now();
  await assert.rejects(
    createEsmsStagingHttpExecutor(hung,settings).execute(request()),
    /ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN/,
  );
  assert.equal(attempts,1);
  assert.equal(aborted,true);
  assert.ok(Date.now()-start>=4800);
  assert.ok(Date.now()-start<12000);
});
