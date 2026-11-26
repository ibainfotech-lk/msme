/**
 * F.17.5c: PURE synthetic environment-boundary preflight.
 *
 * NOT wired to server startup, DB, sessions, network, OTP, bank providers,
 * migration jobs, permissions, feature flags, or customer data.
 * A positive result DOES NOT authorize a deployment or prove attestation.
 * Input is a proposed future snapshot; all independent facts require trusted
 * verification in a separately reviewed implementation.
 */
export type DeploymentStage="LOCAL_DEV"|"DISPOSABLE_CI"|"STAGING"|"PRODUCTION";
export type DeploymentCheckReason=
  "CONDITIONS_MET_NOT_AUTHORIZED" | "INPUT_INCOMPLETE" |
  "STAGE_NODE_ENV_MISMATCH" | "DATABASE_IDENTITY_DENIED" |
  "DATABASE_TRUST_NOT_PROVEN" | "FRONTEND_ORIGIN_DENIED" |
  "SESSION_EDGE_NOT_READY" | "PROVIDER_MODE_DENIED" |
  "CUSTOMER_DATA_OR_FEATURE_DENIED";

export interface ProposedEnvironment {
  deploymentStage:DeploymentStage;
  nodeEnv:"development"|"test"|"production";
  database:{
    profile:DeploymentStage;
    host:string;
    port:number;
    name:string;
    user:string;
    ciDisposableMarkerPresent:boolean;
    targetIndependentlyAttested:boolean;
    privateNetworkVerified:boolean;
    tlsVerified:boolean;
    runtimeRoleLeastPrivilege:boolean;
    migrationRoleSeparate:boolean;
    credentialsIsolated:boolean;
  };
  clientOrigin:string;
  session:{
    secureCookie:boolean;
    httpOnlyCookie:boolean;
    durablePrivateStore:boolean;
    independentlyProvisionedSecret:boolean;
  };
  edge:{
    tlsTerminatedSafely:boolean;
    proxyTrustReviewed:boolean;
    forwardedHeadersSanitized:boolean;
    csrfProtectionReviewed:boolean;
    abuseRateLimitsReviewed:boolean;
  };
  providers:{
    paymentMode:"DISABLED"|"MOCK"|"SANDBOX"|"LIVE";
    otpMode:"DISABLED"|"CONSOLE"|"SANDBOX"|"LIVE";
    mockSettlementEnabled:boolean;
    consoleOtpEnabled:boolean;
  };
  flags:{
    taxReadinessEnabled:boolean;
    taxApprovalEnabled:boolean;
    bookkeepingProductionEnabled:boolean;
    invoiceProductionEnabled:boolean;
    reportProductionEnabled:boolean;
    realCustomerDataEnabled:boolean;
  };
}
export interface EnvironmentCheckResult{
  assessment:"DENIED"|"CONDITIONS_MET_NOT_AUTHORIZED";
  reason:DeploymentCheckReason;
  /** These are always false, regardless of policy result. */
  authorizesStartup:false;
  authorizesDeployment:false;
  authorizesDatabaseConnection:false;
  authorizesProviderCalls:false;
  authorizesCustomerData:false;
  enablesProductionFeatures:false;
}
function result(reason:DeploymentCheckReason):EnvironmentCheckResult{
  return {
    assessment:reason==="CONDITIONS_MET_NOT_AUTHORIZED"?
      "CONDITIONS_MET_NOT_AUTHORIZED":"DENIED",
    reason,
    authorizesStartup:false,authorizesDeployment:false,
    authorizesDatabaseConnection:false,authorizesProviderCalls:false,
    authorizesCustomerData:false,enablesProductionFeatures:false,
  };
}
const localHosts=new Set(["127.0.0.1","localhost","::1"]);
function isLocal(host:string):boolean{
  return localHosts.has(host.toLowerCase());
}
function originValid(value:string,stage:DeploymentStage):boolean {
  if(typeof value!=="string")return false;
  try{
    const parsed=new URL(value);
    if(parsed.username || parsed.password || parsed.search || parsed.hash ||
       parsed.pathname!=="/" || !parsed.hostname)return false;
    if(parsed.origin!==value.replace(/\/$/,""))return false;
    if(stage==="LOCAL_DEV"||stage==="DISPOSABLE_CI"){
      return parsed.protocol==="http:" && isLocal(parsed.hostname);
    }
    return parsed.protocol==="https:" && !isLocal(parsed.hostname) &&
      !parsed.hostname.toLowerCase().endsWith(".localhost");
  }catch{return false;}
}
function hasRecords(v:Partial<ProposedEnvironment>):v is ProposedEnvironment{
  return v!==null && typeof v==="object" &&
    !!v.database && typeof v.database==="object" &&
    !!v.session && typeof v.session==="object" &&
    !!v.edge && typeof v.edge==="object" &&
    !!v.providers && typeof v.providers==="object" &&
    !!v.flags && typeof v.flags==="object";
}

/**
 * Evaluates proposed environment properties without external effects.
 * Never pass the result into a deployment/startup authorization decision.
 */
export function assessProposedEnvironment(
  input:Partial<ProposedEnvironment>|null|undefined
):EnvironmentCheckResult{
  if(!input||!hasRecords(input)||![
    "LOCAL_DEV","DISPOSABLE_CI","STAGING","PRODUCTION"
  ].includes(input.deploymentStage)){
    return result("INPUT_INCOMPLETE");
  }
  const {deploymentStage:stage,nodeEnv,database:db,clientOrigin,session,edge,
    providers,flags}=input;
  const dev=stage==="LOCAL_DEV",ci=stage==="DISPOSABLE_CI";
  if((dev||ci ? nodeEnv!=="development" : nodeEnv!=="production")){
    return result("STAGE_NODE_ENV_MISMATCH");
  }
  if(db.profile!==stage || typeof db.host!=="string"||!db.host.trim()||
     typeof db.name!=="string"||!db.name.trim()||
     typeof db.user!=="string"||!db.user.trim()||
     !Number.isSafeInteger(db.port)||db.port<1||db.port>65535){
    return result("DATABASE_IDENTITY_DENIED");
  }
  if(dev||ci){
    if(!isLocal(db.host)||db.port!==3307||
       db.name!=="noteto_dev"||db.user!=="noteto_services"||
       db.ciDisposableMarkerPresent!==ci){
      return result("DATABASE_IDENTITY_DENIED");
    }
  }else{
    if(isLocal(db.host)||db.host==="0.0.0.0"||
       db.name==="noteto_dev"||db.user==="noteto_services"||
       db.user==="root"||db.user=== "admin" ||
       db.ciDisposableMarkerPresent!==false ||
       !/^[A-Za-z][A-Za-z0-9_.-]{2,127}$/.test(db.name) ||
       !/^[A-Za-z][A-Za-z0-9_.-]{2,127}$/.test(db.user)){
      return result("DATABASE_IDENTITY_DENIED");
    }
    if(db.targetIndependentlyAttested!==true||
       db.privateNetworkVerified!==true||db.tlsVerified!==true||
       db.runtimeRoleLeastPrivilege!==true||
       db.migrationRoleSeparate!==true||
       db.credentialsIsolated!==true){
      return result("DATABASE_TRUST_NOT_PROVEN");
    }
  }
  if(!originValid(clientOrigin,stage)){
    return result("FRONTEND_ORIGIN_DENIED");
  }
  if(!session||session.httpOnlyCookie!==true||
     !session.independentlyProvisionedSecret ||
     !edge || typeof edge!=="object"){
    return result("SESSION_EDGE_NOT_READY");
  }
  if(!dev&&!ci){
    if(session.secureCookie!==true ||
       session.durablePrivateStore!==true ||
       edge.tlsTerminatedSafely!==true||
       edge.proxyTrustReviewed!==true||
       edge.forwardedHeadersSanitized!==true||
       edge.csrfProtectionReviewed!==true||
       edge.abuseRateLimitsReviewed!==true){
      return result("SESSION_EDGE_NOT_READY");
    }
  }
  if(!providers ||
     !["DISABLED","MOCK","SANDBOX","LIVE"].includes(providers.paymentMode)||
     !["DISABLED","CONSOLE","SANDBOX","LIVE"].includes(providers.otpMode)){
    return result("PROVIDER_MODE_DENIED");
  }
  if(dev||ci){
    if(!["DISABLED","MOCK"].includes(providers.paymentMode)||
       !["DISABLED","CONSOLE"].includes(providers.otpMode)||
       providers.mockSettlementEnabled!==false){
      return result("PROVIDER_MODE_DENIED");
    }
  }else if(stage==="STAGING"){
    if(!["DISABLED","SANDBOX"].includes(providers.paymentMode)||
       !["DISABLED","SANDBOX"].includes(providers.otpMode)||
       providers.mockSettlementEnabled!==false||
       providers.consoleOtpEnabled!==false){
      return result("PROVIDER_MODE_DENIED");
    }
  }else{
    // No approved bank or SMS provider exists in current Noteto runtime.
    // A live provider is *not* accepted by this preparatory policy.
    if(providers.paymentMode!=="DISABLED"||
       providers.otpMode!=="DISABLED"||
       providers.mockSettlementEnabled!==false||
       providers.consoleOtpEnabled!==false){
      return result("PROVIDER_MODE_DENIED");
    }
  }
  if(!flags ||
     flags.realCustomerDataEnabled!==false ||
     flags.taxReadinessEnabled!==false||
     flags.taxApprovalEnabled!==false||
     flags.bookkeepingProductionEnabled!==false||
     flags.invoiceProductionEnabled!==false||
     flags.reportProductionEnabled!==false){
    return result("CUSTOMER_DATA_OR_FEATURE_DENIED");
  }
  return result("CONDITIONS_MET_NOT_AUTHORIZED");
}
