import {randomUUID} from "node:crypto";
import type {PoolConnection,RowDataPacket} from "mysql2/promise";
import pool from "../../config/database";
import {viewTaxReadiness,TaxReadinessError,type TaxReadinessRequest} from "./tax-readiness.service";

/**
 * Private preparation questionnaire only. A self-declared "YES" or category
 * is NEVER treated as verified, taxable income, a deduction or relief.
 * No identity number, personal details, monetary adjustment or tax amount.
 */
type Category="UNKNOWN"|"INDIVIDUAL"|"COMPANY"|"OTHER_ENTITY"|"NOT_SURE";
type Residency="UNKNOWN"|"RESIDENT"|"NON_RESIDENT"|"NOT_SURE";
type Answer="UNKNOWN"|"YES"|"NO"|"NOT_SURE";
export interface TaxIntakeClaims{
  taxpayerCategoryClaim:Category;
  residencyClaim:Residency;
  otherIncomeClaim:Answer;
  capitalAssetsClaim:Answer;
  nonDeductibleCostsClaim:Answer;
  withholdingCreditsClaim:Answer;
  ownerIsTaxpayerClaim:Answer;
}
export interface TaxIntakeRequest extends TaxReadinessRequest {}
export interface SaveTaxIntakeRequest extends TaxIntakeRequest{
  expectedRevision:null|number;
  claims:TaxIntakeClaims;
}
export interface TaxIntakeDraftResult{
  status:"UNVERIFIED_DRAFT"|"NOT_STARTED";
  assessmentYear:string;
  revision:number|null;
  claims:TaxIntakeClaims|null;
  legalOrTaxProfessionalVerified:false;
  eligibilityVerified:false;
  taxableIncomeLkr:null;
  taxPayableLkr:null;
  sourceDocumentCollected:false;
}
export class TaxIntakeError extends TaxReadinessError{
  constructor(code:string,statusCode=403){super(code,statusCode);}
}
const cats:Category[]=["UNKNOWN","INDIVIDUAL","COMPANY","OTHER_ENTITY","NOT_SURE"];
const residencies:Residency[]=["UNKNOWN","RESIDENT","NON_RESIDENT","NOT_SURE"];
const answers:Answer[]=["UNKNOWN","YES","NO","NOT_SURE"];
const keys:(keyof TaxIntakeClaims)[]=[
  "taxpayerCategoryClaim","residencyClaim","otherIncomeClaim","capitalAssetsClaim",
  "nonDeductibleCostsClaim","withholdingCreditsClaim","ownerIsTaxpayerClaim"
];
type ConnectionFactory=()=>Promise<PoolConnection>;
interface IntakeRow extends RowDataPacket{
  id:string;revision:number;
  taxpayer_category_claim:Category;residency_claim:Residency;
  other_income_claim:Answer;capital_assets_claim:Answer;
  non_deductible_costs_claim:Answer;withholding_credits_claim:Answer;
  owner_is_taxpayer_claim:Answer;
}
interface PermissionRow extends RowDataPacket {authorized:number}
const selection=[
  "SELECT id,revision,taxpayer_category_claim,residency_claim,",
  "other_income_claim,capital_assets_claim,non_deductible_costs_claim,",
  "withholding_credits_claim,owner_is_taxpayer_claim",
  "FROM taxpayer_intake_drafts WHERE business_id=? AND assessment_year_start=?",
].join(" ");
function extract(row:IntakeRow):TaxIntakeClaims{
  return {
    taxpayerCategoryClaim:row.taxpayer_category_claim,
    residencyClaim:row.residency_claim,
    otherIncomeClaim:row.other_income_claim,
    capitalAssetsClaim:row.capital_assets_claim,
    nonDeductibleCostsClaim:row.non_deductible_costs_claim,
    withholdingCreditsClaim:row.withholding_credits_claim,
    ownerIsTaxpayerClaim:row.owner_is_taxpayer_claim,
  };
}
function validateClaims(value:unknown):asserts value is TaxIntakeClaims{
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw new TaxIntakeError("INVALID_TAX_INTAKE_CLAIMS",400);
  const record=value as Record<string,unknown>;
  if(Object.keys(record).length!==keys.length||
     Object.keys(record).some(x=>!keys.includes(x as keyof TaxIntakeClaims))||
     !cats.includes(record.taxpayerCategoryClaim as Category)||
     !residencies.includes(record.residencyClaim as Residency)||
     keys.slice(2).some(key=>!answers.includes(record[key] as Answer))){
    throw new TaxIntakeError("INVALID_TAX_INTAKE_CLAIMS",400);
  }
}
function view(year:number,row?:IntakeRow):TaxIntakeDraftResult {
  return {
    status:row?"UNVERIFIED_DRAFT":"NOT_STARTED",
    assessmentYear:year+"/"+(year+1),
    revision:row?.revision??null,
    claims:row?extract(row):null,
    legalOrTaxProfessionalVerified:false,eligibilityVerified:false,
    taxableIncomeLkr:null,taxPayableLkr:null,sourceDocumentCollected:false,
  };
}
function enabledWrite():void{
  if(process.env.NODE_ENV!=="development"||
     process.env.NOTETO_F17_TAX_INTAKE_WRITE_ENABLED!=="true"){
    throw new TaxIntakeError("TAX_INTAKE_WRITE_DISABLED",503);
  }
}
async function requireManage(con:PoolConnection,input:TaxIntakeRequest):Promise<void>{
  const [rows]=await con.execute<PermissionRow[]>(
    [
      "SELECT 1 AS authorized FROM business_memberships bm",
      "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
      "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
      "JOIN role_permissions rp ON rp.role_id=r.id",
      "JOIN permissions p ON p.id=rp.permission_id",
      "WHERE bm.business_id=? AND bm.user_id=? AND bm.status='ACTIVE'",
      "AND p.`key`='taxes.manage' LIMIT 1",
    ].join(" "),[input.businessId,input.userId]
  );
  if(rows.length!==1)throw new TaxIntakeError("TAX_INTAKE_MANAGE_PERMISSION_DENIED");
}
export async function readTaxIntakeDraft(
  input:TaxIntakeRequest,getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<TaxIntakeDraftResult>{
  let existing:IntakeRow|undefined;
  await viewTaxReadiness(input,getConnection,async con=>{
    const [rows]=await con.execute<IntakeRow[]>(
      selection,[input.businessId,input.assessmentYearStart]
    );
    existing=rows[0];
    if(rows.length>1)throw new TaxIntakeError("TAX_INTAKE_INTEGRITY_ERROR",409);
  });
  return view(input.assessmentYearStart,existing);
}
export async function saveTaxIntakeDraft(
  input:SaveTaxIntakeRequest,
  getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<TaxIntakeDraftResult>{
  enabledWrite();
  validateClaims(input.claims);
  if(input.expectedRevision!==null&&(
    !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1 ||
    input.expectedRevision>2147483646)){
    throw new TaxIntakeError("INVALID_TAX_INTAKE_REVISION",400);
  }
  let result:TaxIntakeDraftResult|undefined;
  await viewTaxReadiness(input,getConnection,async con=>{
    await requireManage(con,input);
    const [rows]=await con.execute<IntakeRow[]>(
      selection+" FOR UPDATE",[input.businessId,input.assessmentYearStart]
    );
    if(rows.length>1)throw new TaxIntakeError("TAX_INTAKE_INTEGRITY_ERROR",409);
    const row=rows[0];
    if(row){
      if(input.expectedRevision!==row.revision)
        throw new TaxIntakeError("TAX_INTAKE_REVISION_CONFLICT",409);
      const newRev=row.revision+1;
      const [update]=await con.execute(
        [
          "UPDATE taxpayer_intake_drafts SET",
          "taxpayer_category_claim=?,residency_claim=?,other_income_claim=?,",
          "capital_assets_claim=?,non_deductible_costs_claim=?,",
          "withholding_credits_claim=?,owner_is_taxpayer_claim=?,",
          "revision=?,updated_by_user_id=?,updated_at=UTC_TIMESTAMP(3)",
          "WHERE id=? AND business_id=? AND revision=?",
        ].join(" "),[
          input.claims.taxpayerCategoryClaim,input.claims.residencyClaim,
          input.claims.otherIncomeClaim,input.claims.capitalAssetsClaim,
          input.claims.nonDeductibleCostsClaim,input.claims.withholdingCreditsClaim,
          input.claims.ownerIsTaxpayerClaim,newRev,input.userId,row.id,
          input.businessId,row.revision,
        ]
      );
      if((update as {affectedRows:number}).affectedRows!==1)
        throw new TaxIntakeError("TAX_INTAKE_REVISION_CONFLICT",409);
      await con.execute(
        [
          "INSERT INTO taxpayer_intake_draft_audits",
          "(id,business_id,draft_id,revision,changed_by_user_id,previous_claims_json,updated_claims_json)",
          "VALUES (?,?,?,?,?,?,?)",
        ].join(" "),[
          randomUUID(),input.businessId,row.id,newRev,input.userId,
          JSON.stringify(extract(row)),JSON.stringify(input.claims),
        ]
      );
      result=view(input.assessmentYearStart,{...row,revision:newRev,
        taxpayer_category_claim:input.claims.taxpayerCategoryClaim,
        residency_claim:input.claims.residencyClaim,
        other_income_claim:input.claims.otherIncomeClaim,
        capital_assets_claim:input.claims.capitalAssetsClaim,
        non_deductible_costs_claim:input.claims.nonDeductibleCostsClaim,
        withholding_credits_claim:input.claims.withholdingCreditsClaim,
        owner_is_taxpayer_claim:input.claims.ownerIsTaxpayerClaim});
    }else{
      if(input.expectedRevision!==null)
        throw new TaxIntakeError("TAX_INTAKE_REVISION_CONFLICT",409);
      const id=randomUUID(),rev=1;
      await con.execute(
        [
          "INSERT INTO taxpayer_intake_drafts",
          "(id,business_id,assessment_year_start,taxpayer_category_claim,residency_claim,",
          "other_income_claim,capital_assets_claim,non_deductible_costs_claim,",
          "withholding_credits_claim,owner_is_taxpayer_claim,revision,updated_by_user_id)",
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ].join(" "),[
          id,input.businessId,input.assessmentYearStart,
          input.claims.taxpayerCategoryClaim,input.claims.residencyClaim,
          input.claims.otherIncomeClaim,input.claims.capitalAssetsClaim,
          input.claims.nonDeductibleCostsClaim,input.claims.withholdingCreditsClaim,
          input.claims.ownerIsTaxpayerClaim,rev,input.userId,
        ]
      );
      await con.execute(
        [
          "INSERT INTO taxpayer_intake_draft_audits",
          "(id,business_id,draft_id,revision,changed_by_user_id,previous_claims_json,updated_claims_json)",
          "VALUES (?,?,?,?,?,NULL,?)",
        ].join(" "),[randomUUID(),input.businessId,id,rev,input.userId,
        JSON.stringify(input.claims)]
      );
      result=view(input.assessmentYearStart,{
        id,revision:rev,
        taxpayer_category_claim:input.claims.taxpayerCategoryClaim,
        residency_claim:input.claims.residencyClaim,
        other_income_claim:input.claims.otherIncomeClaim,
        capital_assets_claim:input.claims.capitalAssetsClaim,
        non_deductible_costs_claim:input.claims.nonDeductibleCostsClaim,
        withholding_credits_claim:input.claims.withholdingCreditsClaim,
        owner_is_taxpayer_claim:input.claims.ownerIsTaxpayerClaim,
      });
    }
  });
  if(!result)throw new TaxIntakeError("TAX_INTAKE_NOT_SAVED",409);
  return result;
}
