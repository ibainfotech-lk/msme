import assert from "node:assert/strict";
import {test} from "node:test";
import {
  createEsmsStagingHttpExecutor,
  type EsmsInjectedFetch,
  type EsmsStagingExecutorSettings,
} from "../src/services/esms-staging-http-executor";
import {
  createEsmsSandboxTransport,
  type EsmsSandboxConfig,
} from "../src/services/esms-sandbox-transport";

const uid="a91f3c7d2e04";
const fakeToken="synthetic-placeholder-value";
const config:EsmsSandboxConfig={
  stage:"STAGING",senderId:"NOTETO",bearerToken:fakeToken,
  sandboxAccountApproved:true,senderIdApproved:true,
  providerCredentialScoped:true,
};
const settings:EsmsStagingExecutorSettings={
  stage:"STAGING",providerSandboxApproved:true,
  senderIdApproved:true,egressToProviderApproved:true,
  credentialsFromSecretManager:true,
  authorizedTestRecipients:["94712345678"],
  authorizedStatusUids:[uid],
};
const input={
  phoneE164:"+94712345678",
  message:"Synthetic test code 123456",
  syntheticRecipientAuthorized:true,
};
const boundUid={
  uid,recipient:"94712345678",senderId:"NOTETO",
  serverStoredDispatchAuthorized:true,
};
function mockResponse(
  payload:unknown,url:string,overrides?:{
    status?:number; contentType?:string; redirected?:boolean;
    url?:string; contentLength?:string;
  }
){
  const headers:Record<string,string>={
    "content-type":overrides?.contentType??"application/json",
  };
  if(overrides?.contentLength!==undefined)
    headers["content-length"]=overrides.contentLength;
  const res=new Response(JSON.stringify(payload),{
    status:overrides?.status??200,headers,
  });
  return {
    status:res.status,url:overrides?.url??url,
    redirected:overrides?.redirected??false,
    headers:res.headers,body:res.body,
  };
}
function configured(fetcher:EsmsInjectedFetch,s:EsmsStagingExecutorSettings=settings){
  const executor=createEsmsStagingHttpExecutor(fetcher,s);
  return createEsmsSandboxTransport(config,executor);
}
test("synthetic send uses only documented HTTPS POST and bounded response",async()=>{
  let called=0;
  const fetcher:EsmsInjectedFetch=async (url,init)=>{
    called++;
    assert.equal(url,"https://e-sms.lk/api/v3/sms/send");
    assert.equal(init.method,"POST");
    assert.equal(init.redirect,"error");
    assert.equal(init.headers.Authorization,"Bearer "+fakeToken);
    assert.equal(init.headers["Content-Type"],"application/json");
    assert.deepEqual(JSON.parse(init.body??""),{
      recipient:"94712345678",sender_id:"NOTETO",message:input.message,
    });
    return mockResponse({status:"success",data:{
      uid,to:"94712345678",from:"NOTETO",uids:[uid],
    }},url);
  };
  const result=await configured(fetcher).send(input);
  assert.equal(called,1);
  assert.equal(result.outcome,"ACCEPTED_NOT_DELIVERED");
  assert.equal(result.userAuthenticated,false);
  assert.equal(result.businessActivated,false);
});
test("synthetic status lookup uses fixed GET and never verifies OTP",async()=>{
  let called=0;
  const fetcher:EsmsInjectedFetch=async (url,init)=>{
    called++;
    assert.equal(url,"https://e-sms.lk/api/v3/sms/"+uid);
    assert.equal(init.method,"GET");
    assert.equal(init.body,undefined);
    return mockResponse({
      status:"success",data:{
        uid,to:"94712345678",from:"NOTETO",status:"Delivered",
      },
    },url);
  };
  const r=await configured(fetcher).lookup(boundUid);
  assert.equal(called,1);
  assert.equal(r.outcome,"DELIVERED_NOT_VERIFIED");
  assert.equal(r.otpVerified,false);
  assert.equal(r.sessionAuthorized,false);
});
test("pending sender approval, disabled egress or wrong stage blocks before fetch",async()=>{
  const profiles:EsmsStagingExecutorSettings[]=[
    {...settings,senderIdApproved:false},
    {...settings,providerSandboxApproved:false},
    {...settings,egressToProviderApproved:false},
    {...settings,credentialsFromSecretManager:false},
    {...settings,stage:"PRODUCTION"},
    {...settings,stage:"DISPOSABLE_CI"},
    {...settings,authorizedTestRecipients:[]},
  ];
  for(const profile of profiles){
    let called=0;
    const fetcher:EsmsInjectedFetch=async(url)=>{
      called++;return mockResponse({status:"success",data:{uid}},url);
    };
    const r=await configured(fetcher,profile).send(input);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(called,0);
  }
});
test("unlisted test recipient or unknown status UID cannot reach fetch",async()=>{
  let called=0;
  const fetcher:EsmsInjectedFetch=async(url)=>{
    called++;return mockResponse({status:"success",data:{uid}},url);
  };
  const alternate={...settings,authorizedTestRecipients:["94770000000"]};
  const r=await configured(fetcher,alternate).send(input);
  assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(called,0);
  const noUid={...settings,authorizedStatusUids:[]};
  const s=await configured(fetcher,noUid).lookup(boundUid);
  assert.equal(s.outcome,"RECONCILIATION_REQUIRED");
  assert.equal(called,0);
});
test("request redirects, unexpected response URL and non-JSON MIME are rejected",async()=>{
  const candidates=[
    {redirected:true},
    {url:"https://example.org/redirected"},
    {contentType:"text/html"},
    {status:302},
  ];
  for(const item of candidates){
    const fetcher:EsmsInjectedFetch=async url=>
      mockResponse({status:"success",data:{uid}},url,item);
    const r=await configured(fetcher).send(input);
    assert.equal(r.outcome,"RECONCILIATION_REQUIRED");
    assert.equal(r.userAuthenticated,false);
  }
});
