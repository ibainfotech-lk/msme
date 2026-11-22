import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import { decideSubscriptionCapability } from "../subscriptions/subscription-hold-access.policy";

/**
 * F.16.5.4e — DEVELOPMENT-ONLY historical cash entry correction.
 *
 * There is NO HTTP route for this service. It never INSERTs a transaction,
 * switches INCOME/EXPENSE type, creates reports, or initiates a payment.
 * Only transactions created before the audited held_at instant may change.
 * Every change and its prior/new values is committed with a single audit row.
 * Future production enforcement requires least-privilege DB credentials,
 * authorized edit APIs and audit-retention controls.
 */
export class HistoricalEntryEditError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) {
    super(code);
    this.name = "HistoricalEntryEditError";
  }
}

export interface HistoricalEntryEditInput {
  businessId: string;
  userId: string;
  transactionId: string;
  expectedVersion: number;
  amountLkr: string;
  category: string;
  description: string;
  occurredOn: string; // YYYY-MM-DD, never the creation timestamp
  reason: string;
}

export interface HistoricalEntryEditResult {
  transactionId: string;
  auditId: string;
  version: number;
  transactionCreated: false;
  freshReportGenerated: false;
}

interface SubscriptionRow extends RowDataPacket {
  status: string;
  held_at: Date | null;
}
interface PermissionRow extends RowDataPacket { allowed: number }
interface EntryRow extends RowDataPacket {
  id: string;
  created_at: Date;
  transaction_type: "INCOME" | "EXPENSE";
  amount_lkr: string;
  category: string;
  description: string;
  occurred_on: string;
  version: number;
}
type ConnectionFactory = () => Promise<PoolConnection>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = /^(?:0|[1-9][0-9]{0,9})\.\d{2}$/;
const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;

function validOccurredOn(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = isoDate.exec(value);
  if (!match) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function localColomboDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const read = (key: string) => parts.find(p => p.type === key)?.value ?? "";
  return read("year") + "-" + read("month") + "-" + read("day");
}

export async function editHistoricalCashEntry(
  input: HistoricalEntryEditInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<HistoricalEntryEditResult> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_HISTORICAL_EDIT_ENABLED !== "true") {
    throw new HistoricalEntryEditError("HISTORICAL_EDIT_DISABLED", 403);
  }
  if (!uuid.test(input.businessId) || !uuid.test(input.userId) ||
      !uuid.test(input.transactionId)) {
    throw new HistoricalEntryEditError("INVALID_ENTRY_REFERENCE", 400);
  }
  if (!Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 || input.expectedVersion >= 4294967295 ||
      typeof input.amountLkr !== "string" || !money.test(input.amountLkr) ||
      Number(input.amountLkr) <= 0 ||
      typeof input.category !== "string" ||
      input.category.trim().length === 0 || input.category.trim().length > 100 ||
      typeof input.description !== "string" || input.description.length > 500 ||
      !validOccurredOn(input.occurredOn) ||
      typeof input.reason !== "string" ||
      input.reason.trim().length < 3 || input.reason.trim().length > 500) {
    throw new HistoricalEntryEditError("INVALID_ENTRY_CORRECTION", 400);
  }

  const category = input.category.trim();
  const description = input.description.trim();
  const reason = input.reason.trim();
  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;

    // Serialize with all business subscription/payment state changes.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business || business.status !== "ACTIVE") {
      throw new HistoricalEntryEditError("BUSINESS_NOT_AVAILABLE", 403);
    }

    const [subs] = await connection.execute<SubscriptionRow[]>(
      [
        "SELECT bs.status, bs.held_at FROM businesses b",
        "JOIN business_subscriptions bs ON bs.id = b.current_subscription_id",
        "AND bs.business_id = b.id WHERE b.id = ? FOR UPDATE",
      ].join(" "),
      [input.businessId]
    );
    const current = subs[0];
    if (!current || current.status !== "PAST_DUE" ||
        !(current.held_at instanceof Date) ||
        !Number.isFinite(current.held_at.getTime()) ||
        current.held_at.getTime() > Date.now()) {
      throw new HistoricalEntryEditError("REVIEWED_HOLD_REQUIRED", 403);
    }

    const [permissions] = await connection.execute<PermissionRow[]>(
      [
        "SELECT 1 AS allowed FROM business_memberships bm",
        "JOIN users u ON u.id = bm.user_id AND u.status = 'ACTIVE'",
        "JOIN roles r ON r.id = bm.role_id AND r.business_id = bm.business_id",
        "JOIN role_permissions rp ON rp.role_id = r.id",
        "JOIN permissions p ON p.id = rp.permission_id",
        "WHERE bm.business_id = ? AND bm.user_id = ?",
        "AND bm.status = 'ACTIVE' AND p.`key` = 'transactions.update' LIMIT 1",
      ].join(" "),
      [input.businessId, input.userId]
    );
    if (permissions.length !== 1) {
      throw new HistoricalEntryEditError("ENTRY_EDIT_PERMISSION_DENIED", 403);
    }

    // An existing, same-tenant row is mandatory; never UPSERT or fabricate one.
    const [entries] = await connection.execute<EntryRow[]>(
      [
        "SELECT id, transaction_type, amount_lkr, category, description,",
        "DATE_FORMAT(occurred_on, '%Y-%m-%d') AS occurred_on,",
        "created_at, version FROM cash_transactions",
        "WHERE id = ? AND business_id = ? FOR UPDATE",
      ].join(" "),
      [input.transactionId, input.businessId]
    );
    const entry = entries[0];
    if (!entry || !(entry.created_at instanceof Date) ||
        !Number.isFinite(entry.created_at.getTime())) {
      throw new HistoricalEntryEditError("EXISTING_ENTRY_NOT_FOUND", 404);
    }
    if (entry.version !== input.expectedVersion) {
      throw new HistoricalEntryEditError("ENTRY_VERSION_CONFLICT");
    }
    if (entry.created_at.getTime() >= current.held_at.getTime() ||
        input.occurredOn > localColomboDate(current.held_at)) {
      throw new HistoricalEntryEditError("ENTRY_NOT_PRE_HOLD", 403);
    }
    const decision = decideSubscriptionCapability({
      businessStatus: "ACTIVE",
      currentSubscriptionStatus: "PAST_DUE",
      hasAuthorizedMembership: true,
    }, "EDIT_PREVIOUS_ENTRY", {
      kind: "EXISTING_ENTRY", sameBusiness: true, createdBeforeHold: true,
    });
    if (!decision.allowed) throw new HistoricalEntryEditError(decision.code, 403);

    if (String(entry.amount_lkr) === input.amountLkr &&
        entry.category === category &&
        entry.description === description &&
        entry.occurred_on === input.occurredOn) {
      throw new HistoricalEntryEditError("NO_ENTRY_CHANGES", 400);
    }

    const nextVersion = input.expectedVersion + 1;
    const [updated] = await connection.execute<ResultSetHeader>(
      [
        "UPDATE cash_transactions SET amount_lkr = ?, category = ?,",
        "description = ?, occurred_on = ?, version = ?,",
        "updated_at = UTC_TIMESTAMP(3)",
        "WHERE id = ? AND business_id = ? AND version = ?",
      ].join(" "),
      [input.amountLkr, category, description, input.occurredOn, nextVersion,
       input.transactionId, input.businessId, input.expectedVersion]
    );
    if (updated.affectedRows !== 1) {
      throw new HistoricalEntryEditError("ENTRY_VERSION_CONFLICT");
    }

    const auditId = randomUUID();
    await connection.execute(
      [
        "INSERT INTO cash_transaction_edit_audits",
        "(id, business_id, cash_transaction_id, edited_by_user_id,",
        "prior_version, new_version, old_amount_lkr, new_amount_lkr,",
        "old_category, new_category, old_description, new_description,",
        "old_occurred_on, new_occurred_on, reason, edited_at)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
      ].join(" "),
      [auditId, input.businessId, input.transactionId, input.userId,
       input.expectedVersion, nextVersion, entry.amount_lkr, input.amountLkr,
       entry.category, category, entry.description, description,
       entry.occurred_on, input.occurredOn, reason]
    );

    await connection.commit();
    started = false;
    return {
      transactionId: input.transactionId,
      auditId,
      version: nextVersion,
      transactionCreated: false,
      freshReportGenerated: false,
    };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
