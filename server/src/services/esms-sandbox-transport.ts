/**
 * F.17.5g — e-SMS injectable sandbox HTTP boundary.
 *
 * This module does NOT import fetch/https or create an HTTP client.
 * Nothing in the app calls it. Only an injected executor can execute an
 * HTTP request, and it must implement timeout, fixed-host TLS checks, response
 * size limits and no redirects. CI uses a fake in-memory executor.
 *
 * Staging access requires independent vendor, legal and security approval.
 * The boolean flags below are *not themselves* trustworthy attestations;
 * a later trusted runtime must derive them server-side before wiring this.
 *
 * The provider is NOT yet contracted, authorized, or live in Noteto.
 */
import {
  prepareEsmsOtpRequest, interpretEsmsSendResponse,
  type EsmsContractResult,
} from "./esms-offline-contract.adapter";
import {
  prepareEsmsStatusQuery, interpretEsmsStatusResponse,
  type EsmsStatusAssessment,
} from "./esms-offline-status.adapter";

export interface EsmsOutboundHttpRequest {
  readonly url: string;
  readonly method: "POST" | "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "error";
  readonly timeoutMs: 5000;
  readonly maxResponseBytes: 8192;
}
export interface EsmsOutboundHttpResponse {
  readonly status: number;
  /** Already JSON-decoded by the injected, bounded HTTP executor. */
  readonly data: unknown;
}
/**
 * Real executor is deliberately NOT provided. An eventual staging executor
 * must enforce TLS origin, no redirects, timeout and maximum response bytes.
 */
export interface EsmsHttpExecutor {
  execute(req: EsmsOutboundHttpRequest): Promise<EsmsOutboundHttpResponse>;
}
export interface EsmsSandboxConfig {
  stage: "STAGING" | "DISPOSABLE_CI" | "PRODUCTION";
  senderId: string;
  /** Must come from server secret management, never a browser or log. */
  bearerToken: string;
  /** Future server-derived provider/onboarding attestations. */
  sandboxAccountApproved: boolean;
  senderIdApproved: boolean;
  providerCredentialScoped: boolean;
}
export type EsmsSandboxSendResult =
  | EsmsContractResult
  | {
      outcome: "SANDBOX_DISABLED";
      reason: "PROVIDER_NOT_APPROVED" | "INVALID_INPUT";
      permitsOtpVerification: false;
      userAuthenticated: false;
      businessActivated: false;
    };
export type EsmsSandboxStatusResult =
  | EsmsStatusAssessment
  | {
      outcome: "SANDBOX_DISABLED";
      reason: "PROVIDER_NOT_APPROVED" | "INVALID_INPUT";
      permitsAutomaticResend: false;
      otpVerified: false;
      sessionAuthorized: false;
      businessActivated: false;
    };

const tokenPattern = /^[^\s\u0000-\u001f\u007f]{12,256}$/;
const recipientPattern = /^947[0-9]{8}$/;
const senderPattern = /^[A-Za-z0-9]{1,11}$/;
const uidPattern = /^[A-Za-z0-9_-]{8,128}$/;
function ready(cfg: EsmsSandboxConfig | null | undefined): cfg is EsmsSandboxConfig {
  return !!cfg && cfg.stage === "STAGING" &&
    cfg.sandboxAccountApproved === true &&
    cfg.senderIdApproved === true &&
    cfg.providerCredentialScoped === true &&
    typeof cfg.bearerToken === "string" && tokenPattern.test(cfg.bearerToken) &&
    typeof cfg.senderId === "string" && senderPattern.test(cfg.senderId);
}
function deniedSend(reason: "PROVIDER_NOT_APPROVED" | "INVALID_INPUT"):
EsmsSandboxSendResult {
  return {
    outcome:"SANDBOX_DISABLED",reason,
    permitsOtpVerification:false,userAuthenticated:false,businessActivated:false,
  };
}
function deniedStatus(reason: "PROVIDER_NOT_APPROVED" | "INVALID_INPUT"):
EsmsSandboxStatusResult {
  return {
    outcome:"SANDBOX_DISABLED",reason,
    permitsAutomaticResend:false,otpVerified:false,
    sessionAuthorized:false,businessActivated:false,
  };
}
function unknownSend():EsmsSandboxSendResult {
  return {
    outcome:"RECONCILIATION_REQUIRED",
    reason:"PROVIDER_STATE_UNCERTAIN",
    permitsOtpVerification:false,userAuthenticated:false,businessActivated:false,
  };
}
function unknownStatus():EsmsSandboxStatusResult {
  return {
    outcome:"RECONCILIATION_REQUIRED",
    reason:"PROVIDER_LOOKUP_UNCERTAIN",
    providerStatus:null,
    permitsAutomaticResend:false,otpVerified:false,
    sessionAuthorized:false,businessActivated:false,
  };
}
function requestBase(cfg:EsmsSandboxConfig): {
  readonly headers: Readonly<Record<string,string>>;
  readonly redirect:"error";
  readonly timeoutMs:5000;
  readonly maxResponseBytes:8192;
} {
  return {
    headers: {
      Authorization:"Bearer " + cfg.bearerToken,
      Accept:"application/json",
    },
    redirect:"error",timeoutMs:5000,maxResponseBytes:8192,
  };
}

/**
 * Construct without any side effects. The caller is required to supply a
 * separate HTTP executor; this module NEVER opens sockets.
 *
 * Critically this must not be wired to auth routes, public requests or
 * production startup until credential approval, durable dispatch records
 * and real authorization gates exist.
 */
export function createEsmsSandboxTransport(
  config: EsmsSandboxConfig,
  executor: EsmsHttpExecutor,
):{
  send(input:{
    phoneE164:string;
    message:string;
    /** Must be proven by a trusted recipient allowlist in future server code. */
    syntheticRecipientAuthorized:boolean;
  }):Promise<EsmsSandboxSendResult>;
  lookup(expected:{
    uid:string;
    recipient:string;
    senderId:string;
    /** Future service must derive this from a tenant-scoped dispatch row. */
    serverStoredDispatchAuthorized:boolean;
  }):Promise<EsmsSandboxStatusResult>;
}{
  return {
    async send(input):Promise<EsmsSandboxSendResult>{
      if(!ready(config) || !executor || typeof executor.execute!=="function")
        return deniedSend("PROVIDER_NOT_APPROVED");
      if(!input || input.syntheticRecipientAuthorized!==true)
        return deniedSend("INVALID_INPUT");
      let prep:ReturnType<typeof prepareEsmsOtpRequest>;
      try {
        prep=prepareEsmsOtpRequest({
          phoneE164:input.phoneE164,
          senderId:config.senderId,
          message:input.message,
        });
      }catch{
        return deniedSend("INVALID_INPUT");
      }
      const req:EsmsOutboundHttpRequest = {
        ...requestBase(config),
        url:prep.endpoint,
        method:prep.method,
        headers:{...requestBase(config).headers,...prep.headers},
        body:prep.body,
      };
      try{
        const received=await executor.execute(req);
        // An accepted response with an explicit mismatched recipient or sender
        // is NOT trustworthy. The provider's "uid" alone is not delivery.
        const data=received.data;
        if(data && typeof data==="object" && !Array.isArray(data) &&
           (data as {status?:unknown}).status==="success"){
          const body=(data as {data?:unknown}).data;
          if(body && typeof body==="object" && !Array.isArray(body)){
            const m=body as {to?:unknown;from?:unknown;uids?:unknown};
            const recipient=input.phoneE164.slice(1);
            if((m.to!==undefined && m.to!==recipient)||
               (m.from!==undefined && m.from!==config.senderId)||
               (m.uids!==undefined &&
                (!Array.isArray(m.uids)||m.uids.length!==1))){
              return {
                outcome:"RECONCILIATION_REQUIRED",
                reason:"PROVIDER_RESPONSE_UNTRUSTED",
                permitsOtpVerification:false,userAuthenticated:false,
                businessActivated:false,
              };
            }
          }
        }
        return interpretEsmsSendResponse(received.status,received.data);
      }catch{
        // Never leak thrown errors: providers and HTTP clients may embed
        // token, recipient, message text or response payload in an exception.
        // Unknown send outcome MUST be reconciled before any repeat send.
        return unknownSend();
      }
    },
    async lookup(expected):Promise<EsmsSandboxStatusResult>{
      if(!ready(config)||!executor||typeof executor.execute!=="function")
        return deniedStatus("PROVIDER_NOT_APPROVED");
      if(!expected||expected.serverStoredDispatchAuthorized!==true||
         expected.senderId!==config.senderId ||
         typeof expected.recipient!=="string" ||
         !recipientPattern.test(expected.recipient) ||
         typeof expected.uid!=="string"||!uidPattern.test(expected.uid)){
        return deniedStatus("INVALID_INPUT");
      }
      let path:ReturnType<typeof prepareEsmsStatusQuery>;
      try{path=prepareEsmsStatusQuery(expected.uid);}
      catch{return deniedStatus("INVALID_INPUT");}
      const req:EsmsOutboundHttpRequest={
        ...requestBase(config),url:path.url,method:path.method,
      };
      try{
        const res=await executor.execute(req);
        return interpretEsmsStatusResponse(res.status,res.data,expected);
      }catch{return unknownStatus();}
    },
  };
}
