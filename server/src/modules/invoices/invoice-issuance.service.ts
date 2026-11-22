import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { decideSubscriptionCapability } from "../subscriptions/subscription-hold-access.policy";

/**
 * F.17.2 — private-development invoice issuance. Invoices are NOT income:
 * unpaid invoices never create cash_transactions, platform payments or
 * customer-payment allocations. No PDF, VAT/tax calculation or cancellation.
 */
export class InvoiceIssueError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "InvoiceIssueError";
  }
}
export interface InvoiceLineInput {
  description: string;
  quantity: string; // decimal units, 2 decimal places
  unitPriceLkr: string; // LKR, 2 decimals
}
export interface IssueInvoiceInput {
  businessId: string;
  userId: string;
  customerName: string;
  customerEmail?: string | null;
  notes?: string;
  lines: InvoiceLineInput[];
  idempotencyKey: string;
}
export interface InvoiceQuota {
  limit: number;
  used: number;
  remaining: number;
  warningAt28: boolean;
}
export interface IssuedInvoiceResult {
  id: string;
  invoiceNumber: string;
  issuedOn: string;
  billingMonth: string;
  totalLkr: string;
  status: "ISSUED";
  replayed: boolean;
  quota: InvoiceQuota;
  cashbookEntryCreated: false;
  paymentCollected: false;
}
export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  issuedOn: string;
  customerName: string;
  totalLkr: string;
  status: "ISSUED";
  createdAt: string;
}
export interface InvoiceDetail extends InvoiceSummary {
  customerEmail: string | null;
  notes: string;
  lines: Array<InvoiceLineInput & { lineNumber: number; lineTotalLkr: string }>;
}
export interface InvoiceListResult {
  items: InvoiceSummary[];
  nextCursor: { createdAt: string; id: string } | null;
  cashbookEntryCreated: false;
}
interface SubscriptionRow extends RowDataPacket {
  id: string;
  status: string;
  starts_at: Date | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  held_at: Date | null;
  invoice_limit: number;
}
interface PermissionRow extends RowDataPacket { allowed: number }
interface CountRow extends RowDataPacket { n: number }
interface InvoiceRow extends RowDataPacket {
  id: string;
  invoice_number: string;
  billing_month: string;
  issued_on: string;
  customer_name: string;
  customer_email: string | null;
  notes: string;
  total_lkr: string;
  status: "ISSUED";
  request_sha256: string;
  created_at: Date;
}
interface InvoiceLineRow extends RowDataPacket {
  line_number: number;
  description: string;
  quantity: string;
  unit_price_lkr: string;
  line_total_lkr: string;
}
type ConnectionFactory = () => Promise<PoolConnection>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9:_-]{8,100}$/;
const MAX_CENTS = 999999999999n;

function enabled(): void {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_F17_INVOICING_ENABLED !== "true") {
    throw new InvoiceIssueError("INVOICING_NOT_AVAILABLE", 503);
  }
}
function refs(businessId: string, userId: string): void {
  if (!UUID.test(businessId) || !UUID.test(userId)) {
    throw new InvoiceIssueError("INVALID_INVOICE_REFERENCE", 400);
  }
}
function decimal(value: unknown, integralDigits: number): bigint | null {
  if (typeof value !== "string") return null;
  const match = new RegExp("^(?:0|[1-9][0-9]{0," + (integralDigits - 1) + "})\\.[0-9]{2}$").exec(value);
  if (!match) return null;
  const [major, minor] = value.split(".");
  return BigInt(major) * 100n + BigInt(minor);
}
function formatCents(cents: bigint): string {
  return (cents / 100n).toString() + "." + (cents % 100n).toString().padStart(2, "0");
}
function colomboToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const p = (key: string) => parts.find(x => x.type === key)?.value ?? "";
  return p("year") + "-" + p("month") + "-" + p("day");
}
function normalize(input: IssueInvoiceInput) {
  const name = typeof input.customerName === "string" ? input.customerName.trim() : "";
  const email = input.customerEmail === undefined || input.customerEmail === null ||
    input.customerEmail === "" ? null
    : typeof input.customerEmail === "string" ? input.customerEmail.trim().toLowerCase() : null;
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  if (!KEY.test(input.idempotencyKey) ||
      name.length < 2 || name.length > 150 ||
      (input.customerEmail !== undefined && input.customerEmail !== null &&
       input.customerEmail !== "" && !email) ||
      (email !== null && (email.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) ||
      typeof input.notes !== "undefined" && typeof input.notes !== "string" ||
      notes.length > 500 ||
      !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 20) {
    throw new InvoiceIssueError("INVALID_INVOICE", 400);
  }
  let total = 0n;
  const lines = input.lines.map((item, index) => {
    if (item === null || typeof item !== "object" ||
        typeof item.description !== "string" ||
        item.description.trim().length < 2 || item.description.trim().length > 200) {
      throw new InvoiceIssueError("INVALID_INVOICE_LINE", 400);
    }
    const quantity100 = decimal(item.quantity, 8);
    const priceCents = decimal(item.unitPriceLkr, 10);
    if (quantity100 === null || priceCents === null ||
        quantity100 <= 0n || priceCents <= 0n || priceCents > MAX_CENTS) {
      throw new InvoiceIssueError("INVALID_INVOICE_LINE", 400);
    }
    // Decimal multiplication with documented half-up cent rounding per line.
    const lineCents = (quantity100 * priceCents + 50n) / 100n;
    if (lineCents < 1n || lineCents > MAX_CENTS) {
      throw new InvoiceIssueError("INVOICE_AMOUNT_OUT_OF_RANGE", 400);
    }
    total += lineCents;
    if (total > MAX_CENTS) throw new InvoiceIssueError("INVOICE_AMOUNT_OUT_OF_RANGE", 400);
    return {
      lineNumber: index + 1,
      description: item.description.trim(),
      quantity: item.quantity,
      unitPriceLkr: item.unitPriceLkr,
      lineTotalLkr: formatCents(lineCents),
    };
  });
  return { customerName: name, customerEmail: email, notes,
    lines, totalLkr: formatCents(total) };
}
async function tx<T>(
  getConnection: ConnectionFactory,
  fn: (con: PoolConnection, now: Date) => Promise<T>
): Promise<T> {
  const con = await getConnection();
  let started = false;
  try {
    await con.beginTransaction();
    started = true;
    const out = await fn(con, new Date());
    await con.commit();
    started = false;
    return out;
  } catch (e) {
    if (started) await con.rollback();
    throw e;
  } finally { con.release(); }
}
/** Lock tenant before subscription and invoices for all read/write operations. */
async function authorize(
  con: PoolConnection, businessId: string, userId: string,
  permission: "invoices.create" | "invoices.read", now: Date
): Promise<{ subscriptionId: string; limit: number }> {
  const business = await findCheckoutBusinessForUpdate(con, businessId);
  if (!business || business.status !== "ACTIVE") {
    throw new InvoiceIssueError("INVOICE_BUSINESS_NOT_ACTIVE");
  }
  const [subs] = await con.execute<SubscriptionRow[]>(
    [
      "SELECT bs.id,bs.status,bs.starts_at,bs.current_period_end,",
      "bs.trial_ends_at,bs.held_at,sp.invoice_limit FROM businesses b",
      "JOIN business_subscriptions bs ON bs.id=b.current_subscription_id",
      "AND bs.business_id=b.id",
      "JOIN subscription_plans sp ON sp.id=bs.plan_id",
      "WHERE b.id=? FOR UPDATE",
    ].join(" "), [businessId]
  );
  const s = subs[0];
  const end = s?.status === "ACTIVE" ? s.current_period_end
    : s?.status === "TRIALING" ? s.trial_ends_at : null;
  if (!s || !["ACTIVE", "TRIALING"].includes(s.status) ||
      !(s.starts_at instanceof Date) || s.starts_at.getTime() > now.getTime() ||
      !(end instanceof Date) || end.getTime() <= now.getTime() ||
      s.held_at !== null || !Number.isSafeInteger(s.invoice_limit) ||
      s.invoice_limit < 1 || s.invoice_limit > 30) {
    throw new InvoiceIssueError("INVOICE_SUBSCRIPTION_NOT_ELIGIBLE");
  }
  const [roles] = await con.execute<PermissionRow[]>(
    [
      "SELECT 1 AS allowed FROM business_memberships bm",
      "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
      "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
      "JOIN role_permissions rp ON rp.role_id=r.id",
      "JOIN permissions p ON p.id=rp.permission_id",
      "WHERE bm.business_id=? AND bm.user_id=? AND bm.status='ACTIVE'",
      "AND p.`key`=? LIMIT 1",
    ].join(" "), [businessId,userId,permission]
  );
  if (roles.length !== 1) throw new InvoiceIssueError("INVOICE_PERMISSION_DENIED");
  const access = decideSubscriptionCapability({
    businessStatus: "ACTIVE",
    currentSubscriptionStatus: s.status as "ACTIVE" | "TRIALING",
    hasAuthorizedMembership: true,
  }, "CREATE_INVOICE");
  if (!access.allowed || access.mode !== "FULL") {
    throw new InvoiceIssueError("INVOICE_SUBSCRIPTION_NOT_ELIGIBLE");
  }
  return { subscriptionId: s.id, limit: s.invoice_limit };
}
async function monthlyUsed(con: PoolConnection, businessId: string, month: string): Promise<number> {
  const [rows] = await con.execute<CountRow[]>(
    "SELECT COUNT(*) AS n FROM sales_invoices WHERE business_id=? AND billing_month=?",
    [businessId,month]
  );
  return Number(rows[0]?.n ?? 0);
}
function quota(limit: number, used: number): InvoiceQuota {
  return { limit, used, remaining: Math.max(0,limit-used), warningAt28: used >= 28 };
}
function summary(r: InvoiceRow): InvoiceSummary {
  return { id:r.id,invoiceNumber:r.invoice_number,issuedOn:r.issued_on,
    customerName:r.customer_name,totalLkr:String(r.total_lkr),
    status:r.status,createdAt:r.created_at.toISOString() };
}

export async function issueInvoice(
  input: IssueInvoiceInput, getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<IssuedInvoiceResult> {
  enabled(); refs(input.businessId,input.userId);
  const cleaned = normalize(input);
  const hash = createHash("sha256").update(JSON.stringify({
    businessId:input.businessId,userId:input.userId,...cleaned,
  })).digest("hex");
  return tx(getConnection,async (con,now)=>{
    const {subscriptionId,limit} = await authorize(con,input.businessId,input.userId,
      "invoices.create",now);
    const issuedOn = colomboToday(now);
    const billingMonth = issuedOn.slice(0,7)+"-01";
    const [existing] = await con.execute<InvoiceRow[]>(
      [
        "SELECT id,invoice_number,",
        "DATE_FORMAT(issued_on,'%Y-%m-%d') AS issued_on,",
        "DATE_FORMAT(billing_month,'%Y-%m-%d') AS billing_month,",
        "total_lkr,status,request_sha256",
        "FROM sales_invoices WHERE business_id=? AND idempotency_key=? FOR UPDATE",
      ].join(" "),[input.businessId,input.idempotencyKey]
    );
    const used = await monthlyUsed(con,input.businessId,billingMonth);
    if (existing.length) {
      const row = existing[0];
      if (row.request_sha256 !== hash || row.billing_month !== billingMonth) {
        throw new InvoiceIssueError("INVOICE_IDEMPOTENCY_CONFLICT",409);
      }
      return {
        id:row.id,invoiceNumber:row.invoice_number,issuedOn:row.issued_on,
        billingMonth:row.billing_month,totalLkr:String(row.total_lkr),
        status:"ISSUED",replayed:true,quota:quota(limit,used),
        cashbookEntryCreated:false,paymentCollected:false,
      };
    }
    if (used >= limit) throw new InvoiceIssueError("INVOICE_MONTHLY_LIMIT_REACHED",409);
    const sequence = used + 1;
    const invoiceNumber = "NT-"+billingMonth.slice(0,4)+billingMonth.slice(5,7)+
      "-"+String(sequence).padStart(4,"0");
    const id = randomUUID();
    await con.execute(
      [
        "INSERT INTO sales_invoices",
        "(id,business_id,subscription_id,created_by_user_id,invoice_number,",
        "billing_month,invoice_sequence,issued_on,customer_name,customer_email,",
        "notes,total_lkr,status,idempotency_key,request_sha256,created_at)",
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ISSUED',?,?,UTC_TIMESTAMP(3))",
      ].join(" "),[
        id,input.businessId,subscriptionId,input.userId,invoiceNumber,
        billingMonth,sequence,issuedOn,cleaned.customerName,cleaned.customerEmail,
        cleaned.notes,cleaned.totalLkr,input.idempotencyKey,hash,
      ]
    );
    for(const line of cleaned.lines) {
      await con.execute(
        [
          "INSERT INTO sales_invoice_lines",
          "(id,business_id,invoice_id,line_number,description,quantity,unit_price_lkr,line_total_lkr)",
          "VALUES (?,?,?,?,?,?,?,?)",
        ].join(" "),[
          randomUUID(),input.businessId,id,line.lineNumber,line.description,
          line.quantity,line.unitPriceLkr,line.lineTotalLkr,
        ]
      );
    }
    return { id,invoiceNumber,issuedOn,billingMonth,totalLkr:cleaned.totalLkr,
      status:"ISSUED",replayed:false,quota:quota(limit,sequence),
      cashbookEntryCreated:false,paymentCollected:false };
  });
}

export async function listInvoices(
  input:{businessId:string;userId:string;limit?:number;cursor?:{createdAt:string;id:string}},
  getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<InvoiceListResult> {
  enabled();refs(input.businessId,input.userId);
  const limit=input.limit??50;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100 ||
     (input.cursor && (!UUID.test(input.cursor.id) ||
       !Number.isFinite(Date.parse(input.cursor.createdAt)) ||
       new Date(input.cursor.createdAt).toISOString()!==input.cursor.createdAt))) {
    throw new InvoiceIssueError("INVALID_INVOICE_PAGE",400);
  }
  return tx(getConnection,async(con,now)=>{
    await authorize(con,input.businessId,input.userId,"invoices.read",now);
    let filter="";
    const args:(string|Date|number)[]=[input.businessId];
    if(input.cursor){
      filter="AND (created_at < ? OR (created_at = ? AND id < ?))";
      args.push(new Date(input.cursor.createdAt),new Date(input.cursor.createdAt),input.cursor.id);
    }
    args.push(limit+1);
    const [rows]=await con.execute<InvoiceRow[]>(
      [
        "SELECT id,invoice_number,DATE_FORMAT(issued_on,'%Y-%m-%d') AS issued_on,",
        "customer_name,total_lkr,status,created_at FROM sales_invoices",
        "WHERE business_id=?",filter,
        "ORDER BY created_at DESC,id DESC LIMIT ?",
      ].join(" "),args
    );
    const items=rows.slice(0,limit);
    const last=items[items.length-1];
    return {
      items:items.map(summary),
      nextCursor:rows.length>limit && last?{createdAt:last.created_at.toISOString(),id:last.id}:null,
      cashbookEntryCreated:false,
    };
  });
}

export async function getInvoice(
  input:{businessId:string;userId:string;invoiceId:string},
  getConnection:ConnectionFactory=()=>pool.getConnection()
):Promise<InvoiceDetail>{
  enabled();refs(input.businessId,input.userId);
  if(!UUID.test(input.invoiceId))throw new InvoiceIssueError("INVALID_INVOICE_REFERENCE",400);
  return tx(getConnection,async(con,now)=>{
    await authorize(con,input.businessId,input.userId,"invoices.read",now);
    const [invoices]=await con.execute<InvoiceRow[]>(
      [
        "SELECT id,invoice_number,DATE_FORMAT(issued_on,'%Y-%m-%d') AS issued_on,",
        "customer_name,customer_email,notes,total_lkr,status,created_at",
        "FROM sales_invoices WHERE id=? AND business_id=?",
      ].join(" "),[input.invoiceId,input.businessId]
    );
    const invoice=invoices[0];
    if(!invoice)throw new InvoiceIssueError("INVOICE_NOT_FOUND",404);
    const [lines]=await con.execute<InvoiceLineRow[]>(
      [
        "SELECT line_number,description,quantity,unit_price_lkr,line_total_lkr",
        "FROM sales_invoice_lines WHERE invoice_id=? AND business_id=?",
        "ORDER BY line_number ASC",
      ].join(" "),[input.invoiceId,input.businessId]
    );
    return {...summary(invoice),customerEmail:invoice.customer_email,
      notes:invoice.notes,
      lines:lines.map(x=>({lineNumber:x.line_number,description:x.description,
        quantity:String(x.quantity),unitPriceLkr:String(x.unit_price_lkr),
        lineTotalLkr:String(x.line_total_lkr)}))};
  });
}
