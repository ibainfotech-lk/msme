import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { decideSubscriptionCapability } from "../subscriptions/subscription-hold-access.policy";

/**
 * F.17.3 — development-only, live cash-basis summary previews.
 * Report totals come ONLY from business-scoped cash_transactions.
 * Unpaid sales invoices, platform subscription payments and unverified
 * customer payments are not cashbook income.
 *
 * This service does not create, update, or save any report snapshot/PDF.
 * Existing archived PDF retrieval is a separate, hold-safe capability.
 */
export class CashbookReportError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "CashbookReportError";
  }
}
export type CashbookReportPeriod = "DAILY" | "WEEKLY" | "YEARLY";
export interface ReportRequest {
  businessId: string;
  userId: string;
  period: CashbookReportPeriod;
  /** DAILY/WEEKLY: YYYY-MM-DD (week must start Monday); YEARLY: YYYY */
  periodKey: string;
}
export interface CashbookReportTotals {
  cashInLkr: string;
  cashOutLkr: string;
  netMovementLkr: string;
  incomeEntries: number;
  expenseEntries: number;
}
export interface CashbookReportBreakdown extends CashbookReportTotals {
  label: string;
}
export interface CashbookReportCategory {
  transactionType: "INCOME" | "EXPENSE";
  category: string;
  totalLkr: string;
  entries: number;
}
export interface CashbookReportPreview {
  reportType: CashbookReportPeriod;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  currency: "LKR";
  basis: "CASH";
  timezone: "Asia/Colombo";
  generatedAt: string;
  totals: CashbookReportTotals;
  dailyBreakdown: CashbookReportBreakdown[];
  monthlyBreakdown: CashbookReportBreakdown[];
  categoryBreakdown: CashbookReportCategory[];
  /** No opening balance is assumed; net is NOT a reconciled bank balance. */
  reconciledOpeningBalanceAvailable: false;
  cashbookOnly: true;
  invoiceAmountsIncluded: false;
  reportSnapshotSaved: false;
  pdfGenerated: false;
}
interface SubscriptionRow extends RowDataPacket {
  status: string;
  starts_at: Date | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  held_at: Date | null;
}
interface PermissionRow extends RowDataPacket { allowed: number }
interface AggregateRow extends RowDataPacket {
  cash_day: string;
  transaction_type: "INCOME" | "EXPENSE";
  category: string;
  amount_lkr: string;
  entries: number;
}
interface TotalInCents {
  income: bigint;
  expense: bigint;
  incomeEntries: number;
  expenseEntries: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;
const CENTS = /^\d+\.\d{2}$/;
const MAX_REPORT_GROUPS = 10000;
type ConnectionFactory = () => Promise<PoolConnection>;
/**
 * Internal-only, same-transaction persistence hook used by immutable archive
 * generation. Runs after the report is aggregated and BEFORE commit, under
 * the same business/subscription lock as cashbook changes.
 */
export type ReportBeforeCommit = (
  connection: PoolConnection, report: CashbookReportPreview, generatedAt: Date
) => Promise<void>;
function enabled(): void {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_F17_REPORT_PREVIEW_ENABLED !== "true") {
    throw new CashbookReportError("CASHBOOK_REPORTS_DISABLED", 503);
  }
}
function colomboDate(now: Date): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (part: string) => p.find(x => x.type === part)?.value ?? "";
  return value("year") + "-" + value("month") + "-" + value("day");
}
function dateUtc(value: string): Date {
  return new Date(value + "T00:00:00.000Z");
}
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(value: string, days: number): string {
  const date = dateUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}
function validDay(day: string): boolean {
  if(!DAY.test(day) || day < "2000-01-01") return false;
  const parsed=dateUtc(day);
  return Number.isFinite(parsed.getTime()) && isoDay(parsed) === day;
}
function dateBounds(
  period: CashbookReportPeriod,
  periodKey: string,
  now: Date
): {start:string;endExclusive:string;periodEnd:string} {
  const today=colomboDate(now);
  if(period==="YEARLY"){
    if(!YEAR.test(periodKey) || periodKey < "2000" ||
       periodKey > today.slice(0,4)) {
      throw new CashbookReportError("INVALID_REPORT_PERIOD", 400);
    }
    const start=periodKey+"-01-01";
    return {start,endExclusive:(Number(periodKey)+1)+"-01-01",
      periodEnd:periodKey+"-12-31"};
  }
  if(!validDay(periodKey) || periodKey > today) {
    throw new CashbookReportError("INVALID_REPORT_PERIOD", 400);
  }
  if(period==="DAILY") {
    return {start:periodKey,endExclusive:addDays(periodKey,1),periodEnd:periodKey};
  }
  if(period==="WEEKLY" && dateUtc(periodKey).getUTCDay()===1){
    return {start:periodKey,endExclusive:addDays(periodKey,7),periodEnd:addDays(periodKey,6)};
  }
  throw new CashbookReportError("INVALID_REPORT_PERIOD", 400);
}
function asCents(value: string): bigint {
  if(!CENTS.test(value)) throw new CashbookReportError("INVALID_LEDGER_AMOUNT",409);
  const [whole,minor]=value.split(".");
  return BigInt(whole)*100n+BigInt(minor);
}
function money(cents: bigint): string {
  return (cents<0n?"-":"") +
    ((cents<0n?-cents:cents)/100n).toString()+"."+
    ((cents<0n?-cents:cents)%100n).toString().padStart(2,"0");
}
function blank(): TotalInCents {
  return {income:0n,expense:0n,incomeEntries:0,expenseEntries:0};
}
function merge(target: TotalInCents,type:"INCOME"|"EXPENSE",amount:bigint,entries:number):void {
  if(!Number.isSafeInteger(entries) || entries<1) {
    throw new CashbookReportError("INVALID_LEDGER_COUNT",409);
  }
  if(type==="INCOME"){
    target.income+=amount;target.incomeEntries+=entries;
  }else if(type==="EXPENSE"){
    target.expense+=amount;target.expenseEntries+=entries;
  }else{
    throw new CashbookReportError("INVALID_LEDGER_TRANSACTION_TYPE",409);
  }
  if(!Number.isSafeInteger(target.incomeEntries) ||
     !Number.isSafeInteger(target.expenseEntries)){
    throw new CashbookReportError("REPORT_COUNT_OVERFLOW",409);
  }
}
function totals(value:TotalInCents):CashbookReportTotals {
  return {
    cashInLkr:money(value.income),cashOutLkr:money(value.expense),
    netMovementLkr:money(value.income-value.expense),
    incomeEntries:value.incomeEntries,expenseEntries:value.expenseEntries,
  };
}
function put(map:Map<string,TotalInCents>,key:string,type:"INCOME"|"EXPENSE",
             amount:bigint,count:number):void {
  const current=map.get(key)??blank();
  merge(current,type,amount,count);
  map.set(key,current);
}

/**
 * Read-only, repeatable-read transaction. Business lock serializes with
 * existing cashbook edits/creates so a report never mixes before/after
 * versions of a cash transaction. No row-level report snapshots are saved.
 */
export async function previewCashbookReport(
  input:ReportRequest,
  getConnection:ConnectionFactory=()=>pool.getConnection(),
  beforeCommit?:ReportBeforeCommit
):Promise<CashbookReportPreview> {
  enabled();
  if(!UUID.test(input.businessId)||!UUID.test(input.userId) ||
     !["DAILY","WEEKLY","YEARLY"].includes(input.period) ||
     typeof input.periodKey!=="string"){
    throw new CashbookReportError("INVALID_REPORT_REQUEST",400);
  }
  const bounds=dateBounds(input.period,input.periodKey,new Date());
  const con=await getConnection();
  let started=false;
  try{
    await con.beginTransaction();
    started=true;
    const now=new Date();
    const business=await findCheckoutBusinessForUpdate(con,input.businessId);
    if(!business || business.status!=="ACTIVE"){
      throw new CashbookReportError("REPORT_BUSINESS_NOT_ACTIVE");
    }
    const [subscriptions]=await con.execute<SubscriptionRow[]>(
      [
        "SELECT bs.status,bs.starts_at,bs.current_period_end,",
        "bs.trial_ends_at,bs.held_at FROM businesses b",
        "JOIN business_subscriptions bs ON bs.id=b.current_subscription_id",
        "AND bs.business_id=b.id WHERE b.id=? FOR UPDATE",
      ].join(" "),[input.businessId]
    );
    const s=subscriptions[0];
    const validEnd=s?.status==="ACTIVE"?s.current_period_end:
      s?.status==="TRIALING"?s.trial_ends_at:null;
    if(!s || !["ACTIVE","TRIALING"].includes(s.status) ||
       !(s.starts_at instanceof Date) || s.starts_at.getTime()>now.getTime() ||
       !(validEnd instanceof Date) || validEnd.getTime()<=now.getTime() ||
       s.held_at!==null){
      throw new CashbookReportError("REPORT_SUBSCRIPTION_NOT_ELIGIBLE");
    }
    const [roles]=await con.execute<PermissionRow[]>(
      [
        "SELECT 1 AS allowed FROM business_memberships bm",
        "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
        "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
        "JOIN role_permissions rp ON rp.role_id=r.id",
        "JOIN permissions p ON p.id=rp.permission_id",
        "WHERE bm.business_id=? AND bm.user_id=? AND bm.status='ACTIVE'",
        "AND p.`key`='reports.generate' LIMIT 1",
      ].join(" "),[input.businessId,input.userId]
    );
    if(roles.length!==1)throw new CashbookReportError("REPORT_PERMISSION_DENIED");
    const access=decideSubscriptionCapability({
      businessStatus:"ACTIVE",
      currentSubscriptionStatus:s.status as "ACTIVE"|"TRIALING",
      hasAuthorizedMembership:true,
    },"GENERATE_REPORT");
    if(!access.allowed||access.mode!=="FULL"){
      throw new CashbookReportError("REPORT_ACCESS_DENIED");
    }

    // Aggregate by day/category with no sampling. If the configured bound
    // is exceeded, report fails rather than delivering understated totals.
    const [grouped]=await con.execute<AggregateRow[]>(
      [
        "SELECT DATE_FORMAT(occurred_on,'%Y-%m-%d') AS cash_day,",
        "transaction_type,category,",
        "SUM(amount_lkr) AS amount_lkr,COUNT(*) AS entries",
        "FROM cash_transactions WHERE business_id=?",
        "AND occurred_on >= ? AND occurred_on < ?",
        "GROUP BY occurred_on,transaction_type,category",
        "ORDER BY occurred_on ASC,transaction_type ASC,category ASC",
        "LIMIT ?",
      ].join(" "),[input.businessId,bounds.start,bounds.endExclusive,MAX_REPORT_GROUPS+1]
    );
    if(grouped.length>MAX_REPORT_GROUPS){
      throw new CashbookReportError("REPORT_GROUP_LIMIT_EXCEEDED",409);
    }
    const all=blank();
    const dayMap=new Map<string,TotalInCents>();
    const monthMap=new Map<string,TotalInCents>();
    const categoryMap=new Map<string,TotalInCents>();
    for(const row of grouped){
      if(!validDay(row.cash_day)||row.cash_day<bounds.start||
         row.cash_day>=bounds.endExclusive||
         !["INCOME","EXPENSE"].includes(row.transaction_type) ||
         typeof row.category!=="string"){
        throw new CashbookReportError("INVALID_LEDGER_GROUP",409);
      }
      const cents=asCents(String(row.amount_lkr));
      const entries=Number(row.entries);
      merge(all,row.transaction_type,cents,entries);
      put(dayMap,row.cash_day,row.transaction_type,cents,entries);
      put(monthMap,row.cash_day.slice(0,7),row.transaction_type,cents,entries);
      put(categoryMap,JSON.stringify([row.transaction_type,row.category]),
        row.transaction_type,cents,entries);
    }
    // Present explicit zero days/months so charts never confuse absence of
    // entries with missing data. This is a summary, NOT account cash balance.
    const daily:CashbookReportBreakdown[]=[];
    if(input.period!=="YEARLY"){
      for(let day=bounds.start;day<bounds.endExclusive;day=addDays(day,1)){
        daily.push({label:day,...totals(dayMap.get(day)??blank())});
      }
    }
    const monthly:CashbookReportBreakdown[]=[];
    if(input.period==="YEARLY"){
      for(let month=1;month<=12;month++){
        const key=input.periodKey+"-"+String(month).padStart(2,"0");
        monthly.push({label:key,...totals(monthMap.get(key)??blank())});
      }
    }
    const category:CashbookReportCategory[]=[];
    for(const [key,value] of categoryMap){
      const [type,name]=JSON.parse(key) as ["INCOME"|"EXPENSE",string];
      category.push({transactionType:type,category:name,
        totalLkr:money(type==="INCOME"?value.income:value.expense),
        entries:type==="INCOME"?value.incomeEntries:value.expenseEntries});
    }
    category.sort((a,b)=>a.transactionType.localeCompare(b.transactionType) ||
      a.category.localeCompare(b.category));
    const result:CashbookReportPreview = {
      reportType:input.period,periodKey:input.periodKey,
      periodStart:bounds.start,periodEnd:bounds.periodEnd,
      currency:"LKR",basis:"CASH",timezone:"Asia/Colombo",
      generatedAt:now.toISOString(),totals:totals(all),
      dailyBreakdown:daily,monthlyBreakdown:monthly,categoryBreakdown:category,
      reconciledOpeningBalanceAvailable:false,cashbookOnly:true,
      invoiceAmountsIncluded:false,reportSnapshotSaved:false,pdfGenerated:false,
    };
    if(beforeCommit)await beforeCommit(con,result,now);
    await con.commit();started=false;
    return result;
  }catch(e){
    if(started)await con.rollback();
    throw e;
  }finally{con.release();}
}
