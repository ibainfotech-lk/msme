import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessProposedEnvironment,
  type ProposedEnvironment,
  type DeploymentStage,
  type DeploymentCheckReason,
} from "../src/config/proposed-environment-boundary.policy";

function candidate(stage:DeploymentStage="PRODUCTION"):ProposedEnvironment{
  const local=stage==="LOCAL_DEV"||stage==="DISPOSABLE_CI";
  const production=stage==="PRODUCTION";
  return {
    deploymentStage:stage,
    nodeEnv:local?"development":"production",
    database:{
      profile:stage,
      host:local?"127.0.0.1":"db.private.example.internal",
      port:local?3307:3306,
      name:local?"noteto_dev":production?"noteto_app_live":"noteto_app_staging",
      user:local?"noteto_services":production?"noteto_runtime_live":"noteto_runtime_stage",
      ciDisposableMarkerPresent:stage==="DISPOSABLE_CI",
      targetIndependentlyAttested:!local,
      privateNetworkVerified:!local,tlsVerified:!local,
      runtimeRoleLeastPrivilege:!local,migrationRoleSeparate:!local,
      credentialsIsolated:!local,
    },
    clientOrigin:local?"http://localhost:5173":
      production?"https://app.noteto.example":"https://stage.noteto.example",
    session:{
      secureCookie:!local,httpOnlyCookie:true,
      durablePrivateStore:!local,independentlyProvisionedSecret:true,
    },
    edge:{
      tlsTerminatedSafely:!local,proxyTrustReviewed:!local,
      forwardedHeadersSanitized:!local,csrfProtectionReviewed:!local,
      abuseRateLimitsReviewed:!local,
    },
    providers:{
      paymentMode:"DISABLED",otpMode:"DISABLED",
      mockSettlementEnabled:false,consoleOtpEnabled:false,
    },
    flags:{
      taxReadinessEnabled:false,taxApprovalEnabled:false,
      bookkeepingProductionEnabled:false,invoiceProductionEnabled:false,
      reportProductionEnabled:false,realCustomerDataEnabled:false,
    },
  };
}
function denied(value:Partial<ProposedEnvironment>|null,reason:DeploymentCheckReason){
  const r=assessProposedEnvironment(value);
  assert.equal(r.assessment,"DENIED");
  assert.equal(r.reason,reason);
  assert.equal(r.authorizesDeployment,false);
  assert.equal(r.authorizesStartup,false);
  assert.equal(r.authorizesDatabaseConnection,false);
  assert.equal(r.authorizesProviderCalls,false);
  assert.equal(r.authorizesCustomerData,false);
  assert.equal(r.enablesProductionFeatures,false);
}
test("missing and unsupported identity never yield a launch permit",()=>{
  denied(null,"INPUT_INCOMPLETE");
  denied({deploymentStage:"PRODUCTION"},"INPUT_INCOMPLETE");
  const bad=candidate();
  bad.deploymentStage="INVALID" as DeploymentStage;
  denied(bad,"INPUT_INCOMPLETE");
});
test("even fully described synthetic production boundary cannot deploy or connect",()=>{
  for(const stage of [
    "LOCAL_DEV","DISPOSABLE_CI","STAGING","PRODUCTION"
  ] as const){
    const r=assessProposedEnvironment(candidate(stage));
    assert.equal(r.assessment,"CONDITIONS_MET_NOT_AUTHORIZED");
    assert.equal(r.reason,"CONDITIONS_MET_NOT_AUTHORIZED");
    assert.equal(r.authorizesStartup,false);
    assert.equal(r.authorizesDeployment,false);
    assert.equal(r.authorizesDatabaseConnection,false);
    assert.equal(r.authorizesProviderCalls,false);
    assert.equal(r.authorizesCustomerData,false);
    assert.equal(r.enablesProductionFeatures,false);
  }
});
test("NODE_ENV mismatch and fake CI/production identity fail closed",()=>{
  const mismatch=candidate("PRODUCTION");mismatch.nodeEnv="development";
  denied(mismatch,"STAGE_NODE_ENV_MISMATCH");
  const staging=candidate("STAGING");staging.nodeEnv="test";
  denied(staging,"STAGE_NODE_ENV_MISMATCH");
  const dev=candidate("LOCAL_DEV");dev.nodeEnv="production";
  denied(dev,"STAGE_NODE_ENV_MISMATCH");
  const ci=candidate("DISPOSABLE_CI");ci.database.ciDisposableMarkerPresent=false;
  denied(ci,"DATABASE_IDENTITY_DENIED");
  const fakeCi=candidate("PRODUCTION");
  fakeCi.database.ciDisposableMarkerPresent=true;
  denied(fakeCi,"DATABASE_IDENTITY_DENIED");
});
test("dev database target, root, untrusted private host and profile spoofing fail",()=>{
  const devDb=candidate();devDb.database.name="noteto_dev";
  denied(devDb,"DATABASE_IDENTITY_DENIED");
  const devPort=candidate("LOCAL_DEV");devPort.database.port=3306;
  denied(devPort,"DATABASE_IDENTITY_DENIED");
  const localProd=candidate();localProd.database.host="127.0.0.1";
  denied(localProd,"DATABASE_IDENTITY_DENIED");
  const admin=candidate();admin.database.user="root";
  denied(admin,"DATABASE_IDENTITY_DENIED");
  const wrongProfile=candidate();wrongProfile.database.profile="STAGING";
  denied(wrongProfile,"DATABASE_IDENTITY_DENIED");
  const missing=candidate();missing.database.port=0;
  denied(missing,"DATABASE_IDENTITY_DENIED");
});
test("private DB identity, TLS, role separation and credentials all required",()=>{
  const fields=[
    "targetIndependentlyAttested","privateNetworkVerified","tlsVerified",
    "runtimeRoleLeastPrivilege","migrationRoleSeparate","credentialsIsolated",
  ] as const;
  for(const key of fields){
    const c=candidate();c.database[key]=false;
    denied(c,"DATABASE_TRUST_NOT_PROVEN");
  }
});
test("malformed, credential-bearing, off-origin and HTTP production origins denied",()=>{
  const invalid=[
    "http://app.noteto.example","https://localhost",
    "https://u:p@app.noteto.example",
    "https://app.noteto.example/path",
    "https://app.noteto.example/?bad=1",
    "https://app.noteto.example/#x",
    "not-a-url",
  ];
  for(const origin of invalid){
    const c=candidate();c.clientOrigin=origin;
    denied(c,"FRONTEND_ORIGIN_DENIED");
  }
  const dev=candidate("LOCAL_DEV");dev.clientOrigin="https://localhost:5173";
  denied(dev,"FRONTEND_ORIGIN_DENIED");
});
test("production cookie, session, edge, CSRF and abuse protections required",()=>{
  const s=["secureCookie","httpOnlyCookie","durablePrivateStore",
    "independentlyProvisionedSecret"] as const;
  for(const key of s){
    const c=candidate();c.session[key]=false;
    denied(c,"SESSION_EDGE_NOT_READY");
  }
  const e=["tlsTerminatedSafely","proxyTrustReviewed","forwardedHeadersSanitized",
    "csrfProtectionReviewed","abuseRateLimitsReviewed"] as const;
  for(const key of e){
    const c=candidate();c.edge[key]=false;
    denied(c,"SESSION_EDGE_NOT_READY");
  }
});
test("no live bank, sandbox or console OTP in provisional production",()=>{
  for(const paymentMode of ["MOCK","SANDBOX","LIVE"] as const){
    const c=candidate();c.providers.paymentMode=paymentMode;
    denied(c,"PROVIDER_MODE_DENIED");
  }
  for(const otpMode of ["CONSOLE","SANDBOX","LIVE"] as const){
    const c=candidate();c.providers.otpMode=otpMode;
    denied(c,"PROVIDER_MODE_DENIED");
  }
  const mock=candidate();mock.providers.mockSettlementEnabled=true;
  denied(mock,"PROVIDER_MODE_DENIED");
  const otp=candidate();otp.providers.consoleOtpEnabled=true;
  denied(otp,"PROVIDER_MODE_DENIED");
  const staging=candidate("STAGING");staging.providers.paymentMode="LIVE";
  denied(staging,"PROVIDER_MODE_DENIED");
  const ci=candidate("DISPOSABLE_CI");ci.providers.otpMode="LIVE";
  denied(ci,"PROVIDER_MODE_DENIED");
});
test("production features and customer data remain independently prohibited",()=>{
  const fields=[
    "taxReadinessEnabled","taxApprovalEnabled","bookkeepingProductionEnabled",
    "invoiceProductionEnabled","reportProductionEnabled","realCustomerDataEnabled",
  ] as const;
  for(const key of fields){
    const c=candidate();c.flags[key]=true;
    denied(c,"CUSTOMER_DATA_OR_FEATURE_DENIED");
  }
});
