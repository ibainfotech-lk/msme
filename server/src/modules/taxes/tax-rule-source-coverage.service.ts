import type {PoolConnection,RowDataPacket} from "mysql2/promise";
import pool from "../../config/database";
import {
  viewTaxReadiness,TaxReadinessError,
  type TaxReadinessRequest,
} from "./tax-readiness.service";

/**
 * F.17.4b private read-only legal-source catalogue. A REVIEWED document
 * DOES NOT mean the customer's income or tax computation has been approved.
 * No numeric rates, thresholds, tax bases, deductions or payable fields are
 * present in this table or this API.
 */
export interface ReviewedLegalSource {
  sourceCode:string;
  revision:number;
  taxpayerScope:"INDIVIDUAL"|"COMPANY"|"OTHER_ENTITY";
  assessmentYearStart:number;
  effectiveFrom:string;
  effectiveTo:string;
  sourceTitle:string;
  sourceUri:string;
  sourceSha256:string;
  reviewedAt:string;
}
export interface SourceCoverageResult {
  status:"NO_REVIEWED_SOURCES"|"REVIEWED_SOURCES_AVAILABLE";
  assessmentYear:string;
  documents:ReviewedLegalSource[];
  legalSourceReviewAvailable:boolean;
  taxpayerEligibilityConfirmed:false;
  taxRatesReviewedForThisCustomer:false;
  taxableIncomeLkr:null;
  taxPayableLkr:null;
  taxCalculationEnabled:false;
  rulesSeededAutomatically:false;
  reviewRequired:true;
}
interface SourceRow extends RowDataPacket {
  source_code:string;revision:number;
  taxpayer_scope:"INDIVIDUAL"|"COMPANY"|"OTHER_ENTITY";
  assessment_year_start:number;effective_from:string;effective_to:string;
  source_title:string;source_uri:string;source_sha256:string;
  reviewed_at:Date;
}
const HEX64=/^[a-f0-9]{64}$/i;
const SCOPES=["INDIVIDUAL","COMPANY","OTHER_ENTITY"] as const;
function officialUrl(value:string):boolean {
  try{
    const parsed=new URL(value);
    if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.port)return false;
    const host=parsed.hostname.toLowerCase();
    return host==="ird.gov.lk"||host.endsWith(".ird.gov.lk")||
      host==="parliament.lk"||host.endsWith(".parliament.lk");
  }catch{return false;}
}
type ConnectionFactory=()=>Promise<PoolConnection>;
export async function getTaxSourceCoverage(
  input:TaxReadinessRequest,
  getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<SourceCoverageResult>{
  // viewTaxReadiness verifies feature guard, current FULL subscription,
  // business membership and taxes.read. The source query runs in that very
  // same transaction; no parallel request can flip the audited hold mid-read.
  let matches:ReviewedLegalSource[]=[];
  const readiness=await viewTaxReadiness(input,getConnection,
    async(con,start,end)=>{
      const [rows]=await con.execute<SourceRow[]>(
        [
          "SELECT source_code,revision,taxpayer_scope,assessment_year_start,",
          "DATE_FORMAT(effective_from,'%Y-%m-%d') AS effective_from,",
          "DATE_FORMAT(effective_to,'%Y-%m-%d') AS effective_to,",
          "source_title,source_uri,source_sha256,reviewed_at",
          "FROM tax_rule_source_reviews",
          "WHERE assessment_year_start=? AND review_status='REVIEWED'",
          "AND effective_from<=? AND effective_to>=?",
          "ORDER BY taxpayer_scope ASC,source_code ASC,revision DESC LIMIT 51",
        ].join(" "),[input.assessmentYearStart,end,start]
      );
      if(rows.length>50)throw new TaxReadinessError("TAX_SOURCE_REVIEW_LIMIT_EXCEEDED",409);
      matches=rows.map(row=>{
        if(!SCOPES.includes(row.taxpayer_scope) ||
          !Number.isSafeInteger(row.revision)||row.revision<1||
          !Number.isSafeInteger(row.assessment_year_start)||
          !HEX64.test(row.source_sha256)||
          !officialUrl(row.source_uri)||
          typeof row.source_title!=="string"||
          row.source_title.length<5 || row.source_title.length>250||
          !(row.reviewed_at instanceof Date)){
          throw new TaxReadinessError("TAX_SOURCE_REVIEW_EVIDENCE_INVALID",409);
        }
        return {
          sourceCode:row.source_code,revision:row.revision,
          taxpayerScope:row.taxpayer_scope,
          assessmentYearStart:row.assessment_year_start,
          effectiveFrom:row.effective_from,effectiveTo:row.effective_to,
          sourceTitle:row.source_title,sourceUri:row.source_uri,
          sourceSha256:row.source_sha256,
          reviewedAt:row.reviewed_at.toISOString(),
        };
      });
    }
  );
  return {
    status:matches.length?"REVIEWED_SOURCES_AVAILABLE":"NO_REVIEWED_SOURCES",
    assessmentYear:readiness.assessmentYear,documents:matches,
    legalSourceReviewAvailable:matches.length>0,
    taxpayerEligibilityConfirmed:false,taxRatesReviewedForThisCustomer:false,
    taxableIncomeLkr:null,taxPayableLkr:null,taxCalculationEnabled:false,
    rulesSeededAutomatically:false,reviewRequired:true,
  };
}
