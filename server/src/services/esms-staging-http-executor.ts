/**
 * F.17.5h — e-SMS staging HTTP executor with injected fetch.
 *
 * SECURITY / NON-ACTIVATION:
 * - Never imported by auth routes or runtime startup.
 * - No default fetch implementation, tokens, recipient allowlist, UID store,
 *   provider approval or environment wiring is provided.
 * - Only a caller-supplied fetch implementation can create network traffic.
 * - Empty allowlists reject calls. Current sender approval is PENDING.
 * - Synthetic attestation fields must eventually be replaced by trusted,
 *   server-derived proofs; passing them manually is NOT approval to send.
 *
 * GitHub CI injects a fake transport and uses synthetic values only.
 */
import {
  ESMS_SEND_URL,
} from "./esms-offline-contract.adapter";
import {
  ESMS_STATUS_BASE,
} from "./esms-offline-status.adapter";
import type {
  EsmsHttpExecutor,
  EsmsOutboundHttpRequest,
  EsmsOutboundHttpResponse,
} from "./esms-sandbox-transport";

type FetchInit = {
  method:"GET"|"POST";
  headers:Record<string,string>;
  body?:string;
  redirect:"error";
  signal:AbortSignal;
};
type FetchResponse = {
  status:number;
  url:string;
  redirected:boolean;
  headers:{get(name:string):string|null};
  body:{getReader():ReadableStreamDefaultReader<Uint8Array>}|null;
};
/** Injected only. No default global fetch is imported or called here. */
export type EsmsInjectedFetch = (url:string, init:FetchInit)=>Promise<FetchResponse>;

export interface EsmsStagingExecutorSettings {
  stage:"STAGING"|"PRODUCTION"|"DISPOSABLE_CI";
  /** Trusted configuration from an approved sandbox rollout, not a UI flag. */
  providerSandboxApproved:boolean;
  senderIdApproved:boolean;
  egressToProviderApproved:boolean;
  credentialsFromSecretManager:boolean;
  /** Only phone numbers independently registered as consented TEST recipients. */
  authorizedTestRecipients:readonly string[];
  /** Only message UIDs independently recorded for this staging test scope. */
  authorizedStatusUids:readonly string[];
}
const uid=/^[A-Za-z0-9_-]{8,128}$/;
const recipient=/^947[0-9]{8}$/;
const sender=/^[A-Za-z0-9]{1,11}$/;
const token=/^Bearer [^\s\u0000-\u001f\u007f]{12,256}$/;
const messageControl=/[\u0000-\u001f\u007f]/;
const MAX_SEND_BODY_BYTES=2048;
const decoder=new TextDecoder("utf-8",{fatal:true});

function fail():never {
  // Never leak a token, phone, OTP, response, URL or upstream exception.
  throw new Error("ESMS_STAGING_TRANSPORT_DENIED_OR_UNCERTAIN");
}
function isObject(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function eligible(s:EsmsStagingExecutorSettings):boolean {
  return !!s&&s.stage==="STAGING"&&s.providerSandboxApproved===true&&
    s.senderIdApproved===true&&s.egressToProviderApproved===true&&
    s.credentialsFromSecretManager===true&&
    Array.isArray(s.authorizedTestRecipients)&&
    Array.isArray(s.authorizedStatusUids)&&
    s.authorizedTestRecipients.every(x=>typeof x==="string"&&recipient.test(x))&&
    s.authorizedStatusUids.every(x=>typeof x==="string"&&uid.test(x));
}
function validateRequest(
  r:EsmsOutboundHttpRequest,
  settings:EsmsStagingExecutorSettings,
):void{
  if(!r || typeof r!=="object"||!r.headers ||
    r.redirect!=="error"||r.timeoutMs!==5000||
    r.maxResponseBytes!==8192||
    r.headers.Accept!=="application/json"||
    typeof r.headers.Authorization!=="string"||
    !token.test(r.headers.Authorization))fail();

  const headerNames=Object.keys(r.headers).sort();
  const isSend=r.method==="POST"&&r.url===ESMS_SEND_URL;
  const isLookup=r.method==="GET"&&
    typeof r.url==="string"&&r.url.startsWith(ESMS_STATUS_BASE)&&
    uid.test(r.url.slice(ESMS_STATUS_BASE.length));
  if(!isSend&&!isLookup)fail();

  if(isSend){
    if(headerNames.join(",")!=="Accept,Authorization,Content-Type" ||
       r.headers["Content-Type"]!=="application/json" ||
       typeof r.body!=="string"||
       Buffer.byteLength(r.body,"utf8")>MAX_SEND_BODY_BYTES)fail();

    let parsed:unknown;
    try{parsed=JSON.parse(r.body);}catch{fail();}
    if(!isObject(parsed)||Object.keys(parsed).sort().join(",")!==
       "message,recipient,sender_id" ||
       typeof parsed.recipient!=="string"||!recipient.test(parsed.recipient)||
       !settings.authorizedTestRecipients.includes(parsed.recipient)||
       parsed.sender_id!=="NOTETO"||
       typeof parsed.message!=="string"||!parsed.message.trim()||
       parsed.message.length>300||messageControl.test(parsed.message)){
      fail();
    }
    // Require the exact encoding from the already reviewed request builder.
    // This also blocks hidden additional JSON fields or alternate body shapes.
    if(JSON.stringify(parsed)!==r.body)fail();
  }else{
    if(headerNames.join(",")!=="Accept,Authorization"||
       r.body!==undefined ||
       !settings.authorizedStatusUids.includes(r.url.slice(ESMS_STATUS_BASE.length))){
      fail();
    }
  }
}
async function boundedJson(
  response:FetchResponse,
  expectedUrl:string,
  maxBytes:number,
):Promise<unknown>{
  if(!response || !Number.isSafeInteger(response.status) ||
     response.status<100||response.status>599||
     response.redirected!==false||response.url!==expectedUrl||
     (response.status>=300 && response.status<400) ||
     !response.headers || typeof response.headers.get!=="function"||
     !/^application\/json(?:\s*;.*)?$/i.test(
       response.headers.get("content-type")||""
     )){
    fail();
  }
  const headerLength=response.headers.get("content-length");
  if(headerLength!==null &&
    (!/^\d+$/.test(headerLength)||Number(headerLength)>maxBytes)){
    fail();
  }
  if(!response.body || typeof response.body.getReader!=="function")fail();
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  let finished=false;
  try{
    while(true){
      const chunk=await reader.read();
      if(chunk.done){finished=true;break;}
      if(!(chunk.value instanceof Uint8Array))fail();
      size+=chunk.value.byteLength;
      if(size>maxBytes)fail();
      chunks.push(chunk.value);
    }
    const bytes=new Uint8Array(size);
    let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{
      return JSON.parse(decoder.decode(bytes)) as unknown;
    }catch{fail();}
  }finally{
    if(!finished){
      try{await reader.cancel();}catch{/* best effort cleanup */}
    }
    try{reader.releaseLock();}catch{/* best effort cleanup */}
  }
}

/**
 * Create an adapter for an *injected* fetch-like implementation. This does
 * not check real provider approval, credential origin, egress firewall or
 * certificate pinning. The actual staging deployment must validate those
 * independently before injecting a network-capable function.
 *
 * The adapter is not connected to app startup or OTP routes. Do not use it
 * with global fetch until provider onboarding and security sign-off are done.
 */
export function createEsmsStagingHttpExecutor(
  transport:EsmsInjectedFetch,
  settings:EsmsStagingExecutorSettings,
):EsmsHttpExecutor {
  return {
    async execute(request):Promise<EsmsOutboundHttpResponse>{
      if(typeof transport!=="function"||!eligible(settings))fail();
      validateRequest(request,settings);

      const controller=new AbortController();
      let timer:ReturnType<typeof setTimeout>|undefined;
      const deadline=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          controller.abort();
          reject(new Error("ESMS_HTTP_DEADLINE"));
        },5000);
      });
      try{
        const init:FetchInit={
          method:request.method,
          headers:{...request.headers},
          redirect:"error",
          signal:controller.signal,
        };
        if(request.method==="POST")init.body=request.body;
        const response=await Promise.race([
          transport(request.url,init),deadline,
        ]);
        const data=await Promise.race([
          boundedJson(response,request.url,8192),deadline,
        ]);
        return {status:response.status,data};
      }catch{
        // Ambiguous outcomes are handled by the F.17.5g wrapper; no auto retry.
        fail();
      }finally{
        if(timer!==undefined)clearTimeout(timer);
      }
    },
  };
}
