import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import {
  previewCashbookReport, type ReportRequest,
  CashbookReportError,
} from "./cashbook-report.service";
import { renderCashbookSummaryPdf } from "./cashbook-summary-pdf";

/**
 * F.17.3b: generate a one-page English cash-summary PDF and persist it once.
 * Reuses the existing verified archived-report download and held-user logic.
 * No local / production migrations; no cashbook entries or invoices written.
 */
export class ReportSnapshotError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "ReportSnapshotError";
  }
}
type ConnectionFactory=()=>Promise<PoolConnection>;
export interface SaveSnapshotRequest extends ReportRequest {
  /** Opaque client-provided stable UUID; idempotent retries use the same ID. */
  snapshotId: string;
}
export interface SavedSnapshot {
  id: string;
  reportType: "DAILY"|"WEEKLY"|"YEARLY";
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  contentSha256: string;
  contentLength: number;
  replayed: boolean;
  originalSnapshotPreserved: true;
  cashTransactionsWritten: false;
  invoiceAmountsIncluded: false;
}
interface SavedRow extends RowDataPacket {
  id:string;
  business_id:string;
  generated_by_user_id:string;
  report_type:"DAILY"|"WEEKLY"|"YEARLY";
  period_start:string;
  period_end:string;
  generated_at:Date;
  content_sha256:string;
  content_length:number;
}
interface SubscriptionRow extends RowDataPacket {id:string}
interface PermittedRow extends RowDataPacket {allowed:number}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function enabled(){
  if(process.env.NODE_ENV!=="development" ||
     process.env.NOTETO_F17_PDF_ARCHIVE_WRITE_ENABLED!=="true"){
    throw new ReportSnapshotError("REPORT_ARCHIVE_WRITE_DISABLED",503);
  }
}
export async function saveImmutableCashReport(
  input:SaveSnapshotRequest,
  getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<SavedSnapshot>{
  enabled();
  if(!UUID.test(input.businessId)||!UUID.test(input.userId)||
     !UUID.test(input.snapshotId)){
    throw new ReportSnapshotError("INVALID_REPORT_SNAPSHOT_REFERENCE",400);
  }
  let saved:SavedSnapshot|undefined;
  // The report reader locks the business/subscription, verifies FULL access
  // and aggregates the ledger in one transaction before invoking this hook.
  await previewCashbookReport(input,getConnection,async(con,report,now)=>{
    // The customer must also be able to download their own saved PDF.
    const [rights]=await con.execute<PermittedRow[]>(
      [
        "SELECT 1 AS allowed FROM business_memberships bm",
        "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
        "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
        "JOIN role_permissions rp ON rp.role_id=r.id",
        "JOIN permissions p ON p.id=rp.permission_id",
        "WHERE bm.business_id=? AND bm.user_id=? AND bm.status='ACTIVE'",
        "AND p.`key`='reports.read' LIMIT 1",
      ].join(" "),[input.businessId,input.userId]
    );
    if(rights.length!==1)throw new ReportSnapshotError("REPORT_ARCHIVE_READ_PERMISSION_REQUIRED");
    const [subs]=await con.execute<SubscriptionRow[]>(
      "SELECT current_subscription_id AS id FROM businesses WHERE id=? FOR UPDATE",
      [input.businessId]
    );
    const subscriptionId=subs[0]?.id;
    if(!subscriptionId)throw new ReportSnapshotError("REPORT_SUBSCRIPTION_NOT_ELIGIBLE");
    const [existing]=await con.execute<SavedRow[]>(
      [
        "SELECT id,business_id,generated_by_user_id,report_type,",
        "DATE_FORMAT(period_start,'%Y-%m-%d') AS period_start,",
        "DATE_FORMAT(period_end,'%Y-%m-%d') AS period_end,",
        "generated_at,content_sha256,content_length",
        "FROM archived_report_snapshots WHERE id=? FOR UPDATE",
      ].join(" "),[input.snapshotId]
    );
    if(existing.length){
      const s=existing[0];
      if(s.business_id!==input.businessId ||
         s.generated_by_user_id!==input.userId ||
         s.report_type!==report.reportType ||
         s.period_start!==report.periodStart ||
         s.period_end!==report.periodEnd){
        throw new ReportSnapshotError("REPORT_SNAPSHOT_KEY_CONFLICT",409);
      }
      saved={
        id:s.id,reportType:s.report_type,
        periodStart:s.period_start,periodEnd:s.period_end,
        generatedAt:s.generated_at.toISOString(),
        contentSha256:s.content_sha256,contentLength:Number(s.content_length),
        replayed:true,originalSnapshotPreserved:true,
        cashTransactionsWritten:false,invoiceAmountsIncluded:false,
      };
      return;
    }
    let pdf:Buffer;
    try{pdf=renderCashbookSummaryPdf(report);}
    catch(e){
      throw new ReportSnapshotError(
        e instanceof Error?e.message:"REPORT_PDF_RENDER_FAILED",422
      );
    }
    const checksum=createHash("sha256").update(pdf).digest("hex");
    await con.execute(
      [
        "INSERT INTO archived_report_snapshots",
        "(id,business_id,subscription_id,generated_by_user_id,",
        "report_type,period_start,period_end,content_type,content_sha256,",
        "content_length,pdf_bytes,generated_at)",
        "VALUES (?,?,?,?,?,?,?,'application/pdf',?,?,?,?)",
      ].join(" "),[
        input.snapshotId,input.businessId,subscriptionId,input.userId,
        report.reportType,report.periodStart,report.periodEnd,
        checksum,pdf.length,pdf,now,
      ]
    );
    saved={
      id:input.snapshotId,reportType:report.reportType,
      periodStart:report.periodStart,periodEnd:report.periodEnd,
      generatedAt:now.toISOString(),contentSha256:checksum,
      contentLength:pdf.length,replayed:false,
      originalSnapshotPreserved:true,cashTransactionsWritten:false,
      invoiceAmountsIncluded:false,
    };
  });
  if(!saved)throw new CashbookReportError("REPORT_SNAPSHOT_NOT_CREATED",409);
  return saved;
}
