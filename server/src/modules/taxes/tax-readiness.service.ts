import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { decideSubscriptionCapability } from "../subscriptions/subscription-hold-access.policy";

/**
 * F.17.4a — private, read-only tax preparation, NOT tax computation.
 * Cash surplus is not automatically taxable profit. No law/rate/relief
 * is inferred from business registration type or bookkeeping alone.
 * Nothing in this module writes to a tax/billing/payment table.
 */
export class TaxReadinessError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "TaxReadinessError";
  }
}
export interface TaxReadinessRequest {
  businessId: string;
  userId: string;
  /** Sri Lanka year of assessment starts on April 1, e.g. 2026 for 2026/2027. */
  assessmentYearStart: number;
}
export type TaxRegistrationType =
  "SOLE_PROPRIETOR" | "PRIVATE_LIMITED" | "COMMUNITY_ORGANIZATION";
export interface TaxReadinessResult {
  status: "REVIEW_REQUIRED";
  jurisdiction: "LK";
  basis: "RECORDED_CASH_MOVEMENTS_ONLY";
  currency: "LKR";
  registrationType: TaxRegistrationType;
  assessmentYear: string;
  assessmentStart: string;
  assessmentEnd: string;
  movementsRecordedThrough: string;
  completeAssessmentYear: boolean;
  cashReceivedLkr: string;
  cashPaidLkr: string;
  cashMovementSurplusLkr: string;
  incomeEntries: number;
  expenseEntries: number;
  /** Deliberately null, not 0: cannot determine from bookkeeping alone. */
  taxableIncomeLkr: null;
  taxPayableLkr: null;
  taxRatePercent: null;
  personalReliefAppliedLkr: null;
  paymentDueLkr: null;
  personalReliefEligibility: "UNVERIFIED";
  additionalIncomeAndReliefsIncluded: false;
  capitalAndNonDeductibleAdjustmentsIncluded: false;
  invoicesWithoutVerifiedCashExcluded: true;
  requiresQualifiedSriLankanTaxReview: true;
  taxReturnOrPaymentAuthorized: false;
}
interface BusinessRow extends RowDataPacket {
  registration_type: TaxRegistrationType;
}
interface SubRow extends RowDataPacket {
  status: string;
  starts_at: Date | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  held_at: Date | null;
}
interface PermissionRow extends RowDataPacket { granted: number }
interface MoneyRow extends RowDataPacket {
  transaction_type: "INCOME"|"EXPENSE";
  cash_total: string;
  entries: number|string;
}
type ConnectionFactory = () => Promise<PoolConnection>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const centsRe=/^\d+\.\d{2}$/;
function enabled():void {
  if(process.env.NODE_ENV!=="development" ||
     process.env.NOTETO_F17_TAX_READINESS_ENABLED!=="true"){
    throw new TaxReadinessError("TAX_READINESS_DISABLED",503);
  }
}
function colomboToday(now:Date):string {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"Asia/Colombo",year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(now);
  const get=(key:string)=>parts.find(x=>x.type===key)?.value??"";
  return get("year")+"-"+get("month")+"-"+get("day");
}
function tomorrowUtc(day:string):string {
  const d=new Date(day+"T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}
function parseMoney(raw:string):bigint {
  if(!centsRe.test(raw))throw new TaxReadinessError("INVALID_CASHBOOK_TOTAL",409);
  const [whole,minor]=raw.split(".");
  return BigInt(whole)*100n+BigInt(minor);
}
function asLkr(value:bigint):string {
  const absolute=value<0n?-value:value;
  return (value<0n?"-":"")+(absolute/100n).toString()+"."+
    (absolute%100n).toString().padStart(2,"0");
}
export async function viewTaxReadiness(
  input:TaxReadinessRequest,
  getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<TaxReadinessResult> {
  enabled();
  const today=colomboToday(new Date());
  const currentYear=Number(today.slice(0,4));
  if(!uuid.test(input.businessId)||!uuid.test(input.userId) ||
     !Number.isSafeInteger(input.assessmentYearStart) ||
     input.assessmentYearStart<2025 || input.assessmentYearStart>currentYear){
    throw new TaxReadinessError("INVALID_TAX_READINESS_REQUEST",400);
  }
  const start=String(input.assessmentYearStart)+"-04-01";
  const fullYearEnd=String(input.assessmentYearStart+1)+"-03-31";
  const endExclusive=fullYearEnd<today
    ? tomorrowUtc(fullYearEnd):tomorrowUtc(today);
  const recordedThrough=fullYearEnd<today?fullYearEnd:today;
  // If current Colombo date is before April of the selected year, then the
  // assessment period hasn't begun and no number is meaningful.
  if(start>today)throw new TaxReadinessError("ASSESSMENT_YEAR_NOT_STARTED",400);
  const con=await getConnection();
  let started=false;
  try{
    await con.beginTransaction();started=true;
    const now=new Date();
    const business=await findCheckoutBusinessForUpdate(con,input.businessId);
    if(!business||business.status!=="ACTIVE")
      throw new TaxReadinessError("TAX_BUSINESS_NOT_ACTIVE");
    const [identity]=await con.execute<BusinessRow[]>(
      "SELECT registration_type FROM businesses WHERE id=? FOR UPDATE",
      [input.businessId]
    );
    const registrationType=identity[0]?.registration_type;
    if(!registrationType||![
      "SOLE_PROPRIETOR","PRIVATE_LIMITED","COMMUNITY_ORGANIZATION",
    ].includes(registrationType)){
      throw new TaxReadinessError("TAX_REGISTRATION_TYPE_UNSUPPORTED",409);
    }
    const [sub]=await con.execute<SubRow[]>(
      [
        "SELECT bs.status,bs.starts_at,bs.current_period_end,",
        "bs.trial_ends_at,bs.held_at FROM businesses b",
        "JOIN business_subscriptions bs ON bs.id=b.current_subscription_id",
        "AND bs.business_id=b.id WHERE b.id=? FOR UPDATE",
      ].join(" "),[input.businessId]
    );
    const s=sub[0];
    const end=s?.status==="ACTIVE"?s.current_period_end:
      s?.status==="TRIALING"?s.trial_ends_at:null;
    if(!s||!["ACTIVE","TRIALING"].includes(s.status) ||
       !(s.starts_at instanceof Date)||s.starts_at.getTime()>now.getTime() ||
       !(end instanceof Date)||end.getTime()<=now.getTime() ||
       s.held_at!==null){
      throw new TaxReadinessError("TAX_SUBSCRIPTION_NOT_ELIGIBLE");
    }
    const [perm]=await con.execute<PermissionRow[]>(
      [
        "SELECT 1 AS granted FROM business_memberships bm",
        "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
        "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
        "JOIN role_permissions rp ON rp.role_id=r.id",
        "JOIN permissions p ON p.id=rp.permission_id",
        "WHERE bm.business_id=? AND bm.user_id=? AND bm.status='ACTIVE'",
        "AND p.`key`='taxes.read' LIMIT 1",
      ].join(" "),[input.businessId,input.userId]
    );
    if(perm.length!==1)throw new TaxReadinessError("TAX_PERMISSION_DENIED");
    const access=decideSubscriptionCapability({
      businessStatus:"ACTIVE",
      currentSubscriptionStatus:s.status as "ACTIVE"|"TRIALING",
      hasAuthorizedMembership:true,
    },"GENERATE_REPORT");
    if(!access.allowed||access.mode!=="FULL")
      throw new TaxReadinessError("TAX_ACCESS_DENIED");
    const [groups]=await con.execute<MoneyRow[]>(
      [
        "SELECT transaction_type,",
        "SUM(amount_lkr) AS cash_total,COUNT(*) AS entries",
        "FROM cash_transactions WHERE business_id=?",
        "AND occurred_on>=? AND occurred_on<?",
        "GROUP BY transaction_type",
      ].join(" "),[input.businessId,start,endExclusive]
    );
    let received=0n,paid=0n,incomeEntries=0,expenseEntries=0;
    for(const row of groups){
      const amount=parseMoney(String(row.cash_total));
      const entries=Number(row.entries);
      if(!Number.isSafeInteger(entries)||entries<1 ||
         amount<=0n){
        throw new TaxReadinessError("INVALID_CASHBOOK_TOTAL",409);
      }
      if(row.transaction_type==="INCOME"){
        received+=amount;incomeEntries+=entries;
      }else if(row.transaction_type==="EXPENSE"){
        paid+=amount;expenseEntries+=entries;
      }else throw new TaxReadinessError("INVALID_CASHBOOK_TRANSACTION",409);
    }
    if(!Number.isSafeInteger(incomeEntries)||!Number.isSafeInteger(expenseEntries))
      throw new TaxReadinessError("INVALID_CASHBOOK_TOTAL",409);
    await con.commit();started=false;
    return {
      status:"REVIEW_REQUIRED",jurisdiction:"LK",
      basis:"RECORDED_CASH_MOVEMENTS_ONLY",currency:"LKR",
      registrationType,
      assessmentYear:String(input.assessmentYearStart)+"/"+
        String(input.assessmentYearStart+1),
      assessmentStart:start,assessmentEnd:fullYearEnd,
      movementsRecordedThrough:recordedThrough,
      completeAssessmentYear:recordedThrough===fullYearEnd,
      cashReceivedLkr:asLkr(received),cashPaidLkr:asLkr(paid),
      cashMovementSurplusLkr:asLkr(received-paid),
      incomeEntries,expenseEntries,
      taxableIncomeLkr:null,taxPayableLkr:null,taxRatePercent:null,
      personalReliefAppliedLkr:null,paymentDueLkr:null,
      personalReliefEligibility:"UNVERIFIED",
      additionalIncomeAndReliefsIncluded:false,
      capitalAndNonDeductibleAdjustmentsIncluded:false,
      invoicesWithoutVerifiedCashExcluded:true,
      requiresQualifiedSriLankanTaxReview:true,
      taxReturnOrPaymentAuthorized:false,
    };
  }catch(e){
    if(started)await con.rollback();
    throw e;
  }finally{con.release();}
}
