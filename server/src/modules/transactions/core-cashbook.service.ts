import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { decideSubscriptionCapability } from "../subscriptions/subscription-hold-access.policy";

/**
 * F.17.1: development-only, cash-basis manual entries.
 * These are money-already-received / money-already-paid entries, NOT invoices,
 * receivables, payables, bank settlement or report-generation instructions.
 * Production routing and service execution are both disabled.
 */
export class CoreCashbookError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "CoreCashbookError";
  }
}

type EntryType = "INCOME" | "EXPENSE";
type ConnectionFactory = () => Promise<PoolConnection>;
interface Ref { businessId: string; userId: string }
interface Fields {
  amountLkr: string;
  category: string;
  description: string;
  occurredOn: string;
}
export interface CreateCashEntryInput extends Ref, Fields {
  transactionType: EntryType;
  cashConfirmed: true;
  idempotencyKey: string;
}
export interface UpdateCashEntryInput extends Ref, Fields {
  transactionId: string;
  expectedVersion: number;
  reason: string;
}
export interface ListCashEntryInput extends Ref {
  limit?: number;
  cursor?: { occurredOn: string; id: string };
}
export interface CashEntry {
  id: string;
  transactionType: EntryType;
  amountLkr: string;
  category: string;
  description: string;
  occurredOn: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}
export interface CreateCashEntryResult {
  transactionId: string;
  version: number;
  replayed: boolean;
  created: boolean;
  reportGenerated: false;
  invoiceCreated: false;
}
export interface UpdateCashEntryResult {
  transactionId: string;
  auditId: string;
  version: number;
  created: false;
  reportGenerated: false;
}
export interface ListCashEntryResult {
  items: CashEntry[];
  nextCursor: { occurredOn: string; id: string } | null;
  mode: "FULL";
  reportGenerated: false;
}
interface SubscriptionRow extends RowDataPacket {
  status: string;
  starts_at: Date | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  held_at: Date | null;
}
interface PermissionRow extends RowDataPacket { allowed: number }
interface EntryRow extends RowDataPacket {
  id: string;
  transaction_type: EntryType;
  amount_lkr: string;
  category: string;
  description: string;
  occurred_on: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}
interface CreateReceiptRow extends RowDataPacket {
  cash_transaction_id: string;
  request_sha256: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab0-9]{12}$/i;
const MONEY = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9:_-]{8,100}$/;
function enabled(): void {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_F17_BOOKKEEPING_ENABLED !== "true") {
    throw new CoreCashbookError("CORE_BOOKKEEPING_DISABLED", 503);
  }
}
function validateRef(input: Ref): void {
  if (!UUID.test(input.businessId) || !UUID.test(input.userId)) {
    throw new CoreCashbookError("INVALID_CASHBOOK_REFERENCE", 400);
  }
}
function colomboDate(now: Date): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (key: string) => p.find(x => x.type === key)?.value ?? "";
  return value("year") + "-" + value("month") + "-" + value("day");
}
function validDate(value: string, now: Date): boolean {
  if (typeof value !== "string" || !DATE.test(value) ||
      value < "2000-01-01" || value > colomboDate(now)) return false;
  const d = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validateFields(input: Fields, now: Date): Fields {
  if (typeof input.amountLkr !== "string" || !MONEY.test(input.amountLkr) ||
      Number(input.amountLkr) <= 0 ||
      Number(input.amountLkr) > 9999999999.99 ||
      typeof input.category !== "string" ||
      input.category.trim().length < 1 || input.category.trim().length > 100 ||
      typeof input.description !== "string" ||
      input.description.trim().length > 500 ||
      !validDate(input.occurredOn, now)) {
    throw new CoreCashbookError("INVALID_CASH_ENTRY", 400);
  }
  return {
    amountLkr: input.amountLkr,
    category: input.category.trim(),
    description: input.description.trim(),
    occurredOn: input.occurredOn,
  };
}
function mapRow(row: EntryRow): CashEntry {
  return {
    id: row.id,
    transactionType: row.transaction_type,
    amountLkr: String(row.amount_lkr),
    category: row.category,
    description: row.description,
    occurredOn: row.occurred_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
/**
 * Always lock business BEFORE subscription and entry, as with existing
 * checkout and historical-edit services. No permission is accepted from UI.
 */
async function authorize(
  connection: PoolConnection,
  input: Ref,
  permission: "transactions.create" | "transactions.read" | "transactions.update",
  capability: "CREATE_INCOME" | "CREATE_EXPENSE" | "VIEW_PREVIOUS_ENTRIES" | "EDIT_PREVIOUS_ENTRY",
  now: Date
): Promise<void> {
  const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
  if (!business || business.status !== "ACTIVE") {
    throw new CoreCashbookError("BUSINESS_NOT_ACTIVE");
  }
  const [subscriptions] = await connection.execute<SubscriptionRow[]>(
    [
      "SELECT bs.status, bs.starts_at, bs.current_period_end,",
      "bs.trial_ends_at, bs.held_at FROM businesses b",
      "JOIN business_subscriptions bs ON bs.id = b.current_subscription_id",
      "AND bs.business_id = b.id WHERE b.id = ? FOR UPDATE",
    ].join(" "),
    [input.businessId]
  );
  const subscription = subscriptions[0];
  const validStart = subscription?.starts_at instanceof Date &&
    Number.isFinite(subscription.starts_at.getTime()) &&
    subscription.starts_at.getTime() <= now.getTime();
  const validEnd = subscription?.status === "ACTIVE"
    ? subscription.current_period_end instanceof Date &&
      subscription.current_period_end.getTime() > now.getTime()
    : subscription?.status === "TRIALING" &&
      subscription.trial_ends_at instanceof Date &&
      subscription.trial_ends_at.getTime() > now.getTime();
  if (!subscription || !validStart || !validEnd || subscription.held_at !== null ||
      !["ACTIVE", "TRIALING"].includes(subscription.status)) {
    throw new CoreCashbookError("SUBSCRIPTION_NOT_WRITABLE");
  }
  const [permissions] = await connection.execute<PermissionRow[]>(
    [
      "SELECT 1 AS allowed FROM business_memberships bm",
      "JOIN users u ON u.id=bm.user_id AND u.status='ACTIVE'",
      "JOIN roles r ON r.id=bm.role_id AND r.business_id=bm.business_id",
      "JOIN role_permissions rp ON rp.role_id=r.id",
      "JOIN permissions p ON p.id=rp.permission_id",
      "WHERE bm.business_id=? AND bm.user_id=? AND bm.status='ACTIVE'",
      "AND p.`key`=? LIMIT 1",
    ].join(" "),
    [input.businessId, input.userId, permission]
  );
  if (permissions.length !== 1) {
    throw new CoreCashbookError("CASHBOOK_PERMISSION_DENIED");
  }
  const decision = decideSubscriptionCapability({
    businessStatus: "ACTIVE",
    currentSubscriptionStatus: subscription.status as "ACTIVE" | "TRIALING",
    hasAuthorizedMembership: true,
  }, capability, capability === "EDIT_PREVIOUS_ENTRY"
    ? { kind: "EXISTING_ENTRY", sameBusiness: true, createdBeforeHold: false }
    : undefined);
  if (!decision.allowed || decision.mode !== "FULL") {
    throw new CoreCashbookError(decision.code);
  }
}
async function inTransaction<T>(
  work: (connection: PoolConnection, now: Date) => Promise<T>,
  getConnection: ConnectionFactory
): Promise<T> {
  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    const result = await work(connection, new Date());
    await connection.commit();
    started = false;
    return result;
  } catch (e) {
    if (started) await connection.rollback();
    throw e;
  } finally { connection.release(); }
}

export async function createCashEntry(
  input: CreateCashEntryInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<CreateCashEntryResult> {
  enabled();
  validateRef(input);
  const now = new Date();
  const fields = validateFields(input, now);
  if (!["INCOME", "EXPENSE"].includes(input.transactionType) ||
      input.cashConfirmed !== true || !KEY.test(input.idempotencyKey)) {
    throw new CoreCashbookError("CASH_CONFIRMATION_REQUIRED", 400);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    businessId: input.businessId, userId: input.userId,
    transactionType: input.transactionType, ...fields,
    cashConfirmed: true,
  })).digest("hex");
  return inTransaction(async (connection, at) => {
    await authorize(connection, input, "transactions.create",
      input.transactionType === "INCOME" ? "CREATE_INCOME" : "CREATE_EXPENSE", at);
    const [prior] = await connection.execute<CreateReceiptRow[]>(
      [
        "SELECT cash_transaction_id, request_sha256",
        "FROM cash_transaction_create_requests",
        "WHERE business_id=? AND idempotency_key=? FOR UPDATE",
      ].join(" "), [input.businessId, input.idempotencyKey]
    );
    if (prior.length) {
      if (prior[0].request_sha256 !== fingerprint) {
        throw new CoreCashbookError("CASH_REQUEST_REPLAY_CONFLICT", 409);
      }
      const [entry] = await connection.execute<EntryRow[]>(
        "SELECT version FROM cash_transactions WHERE id=? AND business_id=?",
        [prior[0].cash_transaction_id, input.businessId]
      );
      if (entry.length !== 1) throw new CoreCashbookError("CASH_REQUEST_INTEGRITY_ERROR", 409);
      return {
        transactionId: prior[0].cash_transaction_id,
        version: entry[0].version,
        replayed: true, created: false, reportGenerated: false, invoiceCreated: false,
      };
    }
    const id = randomUUID();
    await connection.execute(
      [
        "INSERT INTO cash_transactions",
        "(id,business_id,created_by_user_id,transaction_type,amount_lkr,",
        "category,description,occurred_on,created_at,updated_at,version)",
        "VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1)",
      ].join(" "),
      [id,input.businessId,input.userId,input.transactionType,fields.amountLkr,
       fields.category,fields.description,fields.occurredOn]
    );
    await connection.execute(
      [
        "INSERT INTO cash_transaction_create_requests",
        "(id,business_id,cash_transaction_id,created_by_user_id,",
        "idempotency_key,request_sha256,created_at)",
        "VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))",
      ].join(" "),
      [randomUUID(),input.businessId,id,input.userId,input.idempotencyKey,fingerprint]
    );
    return {
      transactionId: id, version: 1,
      replayed: false, created: true, reportGenerated: false, invoiceCreated: false,
    };
  }, getConnection);
}

export async function updateActiveCashEntry(
  input: UpdateCashEntryInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<UpdateCashEntryResult> {
  enabled();
  validateRef(input);
  if (!UUID.test(input.transactionId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 || input.expectedVersion >= 4294967295 ||
      typeof input.reason !== "string" ||
      input.reason.trim().length < 3 || input.reason.trim().length > 500) {
    throw new CoreCashbookError("INVALID_CASH_EDIT", 400);
  }
  const fields = validateFields(input, new Date());
  return inTransaction(async (connection, now) => {
    await authorize(connection, input, "transactions.update", "EDIT_PREVIOUS_ENTRY", now);
    const [entries] = await connection.execute<EntryRow[]>(
      [
        "SELECT id,transaction_type,amount_lkr,category,description,",
        "DATE_FORMAT(occurred_on,'%Y-%m-%d') AS occurred_on,created_at,",
        "updated_at,version FROM cash_transactions",
        "WHERE id=? AND business_id=? FOR UPDATE",
      ].join(" "),
      [input.transactionId,input.businessId]
    );
    const before = entries[0];
    if (!before) throw new CoreCashbookError("CASH_ENTRY_NOT_FOUND", 404);
    if (before.version !== input.expectedVersion) {
      throw new CoreCashbookError("CASH_ENTRY_VERSION_CONFLICT", 409);
    }
    if (String(before.amount_lkr) === fields.amountLkr &&
        before.category === fields.category &&
        before.description === fields.description &&
        before.occurred_on === fields.occurredOn) {
      throw new CoreCashbookError("NO_CASH_ENTRY_CHANGES", 400);
    }
    const nextVersion = input.expectedVersion + 1;
    const [changed] = await connection.execute<ResultSetHeader>(
      [
        "UPDATE cash_transactions SET amount_lkr=?,category=?,description=?,",
        "occurred_on=?,version=?,updated_at=UTC_TIMESTAMP(3)",
        "WHERE id=? AND business_id=? AND version=?",
      ].join(" "),
      [fields.amountLkr,fields.category,fields.description,fields.occurredOn,
       nextVersion,input.transactionId,input.businessId,input.expectedVersion]
    );
    if (changed.affectedRows !== 1) {
      throw new CoreCashbookError("CASH_ENTRY_VERSION_CONFLICT", 409);
    }
    const auditId = randomUUID();
    await connection.execute(
      [
        "INSERT INTO cash_transaction_edit_audits",
        "(id,business_id,cash_transaction_id,edited_by_user_id,",
        "prior_version,new_version,old_amount_lkr,new_amount_lkr,",
        "old_category,new_category,old_description,new_description,",
        "old_occurred_on,new_occurred_on,reason,edited_at)",
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))",
      ].join(" "),
      [auditId,input.businessId,input.transactionId,input.userId,
       input.expectedVersion,nextVersion,before.amount_lkr,fields.amountLkr,
       before.category,fields.category,before.description,fields.description,
       before.occurred_on,fields.occurredOn,input.reason.trim()]
    );
    return {
      transactionId:input.transactionId,auditId,version:nextVersion,
      created:false,reportGenerated:false,
    };
  },getConnection);
}

export async function listActiveCashEntries(
  input: ListCashEntryInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<ListCashEntryResult> {
  enabled();
  validateRef(input);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (input.cursor !== undefined &&
       (!UUID.test(input.cursor.id) ||
        !validDate(input.cursor.occurredOn,new Date())))) {
    throw new CoreCashbookError("INVALID_CASHBOOK_PAGE",400);
  }
  return inTransaction(async (connection,now) => {
    await authorize(connection,input,"transactions.read","VIEW_PREVIOUS_ENTRIES",now);
    const params: (string | number)[] = [input.businessId];
    let cursorFilter = "";
    if (input.cursor) {
      cursorFilter = "AND (occurred_on < ? OR (occurred_on = ? AND id < ?))";
      params.push(input.cursor.occurredOn,input.cursor.occurredOn,input.cursor.id);
    }
    params.push(limit+1);
    const [rows] = await connection.execute<EntryRow[]>(
      [
        "SELECT id,transaction_type,amount_lkr,category,description,",
        "DATE_FORMAT(occurred_on,'%Y-%m-%d') AS occurred_on,",
        "created_at,updated_at,version FROM cash_transactions",
        "WHERE business_id=?", cursorFilter,
        "ORDER BY occurred_on DESC,id DESC LIMIT ?",
      ].join(" "),params
    );
    const visible = rows.slice(0,limit);
    const last = visible[visible.length-1];
    return {
      items:visible.map(mapRow),
      nextCursor:rows.length > limit && last
        ? {occurredOn:last.occurred_on,id:last.id} : null,
      mode:"FULL",reportGenerated:false,
    };
  },getConnection);
}
