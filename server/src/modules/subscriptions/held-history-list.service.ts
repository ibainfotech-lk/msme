import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import { findCheckoutBusinessForUpdate } from "../checkout/checkout.repository";
import {
  decideSubscriptionCapability,
  type AccessMode,
  type BusinessCapability,
  type SubscriptionAccessState,
} from "./subscription-hold-access.policy";

/**
 * F.16.5.4f: internal, read-only tenant-scoped history browser.
 * Nothing here creates a transaction, generates a report, starts a payment
 * or reopens held access. An actual HTTP adapter is separately gated.
 */
export class HeldHistoryError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "HeldHistoryError";
  }
}

export interface HeldHistoryInput {
  userId: string;
  businessId: string;
}

export interface PreviousEntry {
  id: string;
  type: "INCOME" | "EXPENSE";
  amountLkr: string;
  category: string;
  description: string;
  occurredOn: string;
  createdAt: Date;
  version: number;
}

export interface PreviousReport {
  id: string;
  type: "DAILY" | "WEEKLY" | "YEARLY";
  generatedAt: Date;
  periodStart: string;
  periodEnd: string;
}

export interface HeldHistoryResult<T> {
  mode: "FULL" | "HOLD";
  items: T[];
  limitedTo: 100;
  newEntryAllowed: false;
  reportGenerationAllowed: false;
}

interface SubscriptionRow extends RowDataPacket {
  status: SubscriptionAccessState["currentSubscriptionStatus"];
  held_at: Date | null;
}
interface PermissionRow extends RowDataPacket { allowed: number }
interface EntryRow extends RowDataPacket {
  id: string;
  transaction_type: "INCOME" | "EXPENSE";
  amount_lkr: string;
  category: string;
  description: string;
  occurred_on: string;
  created_at: Date;
  version: number;
}
interface ReportRow extends RowDataPacket {
  id: string;
  report_type: "DAILY" | "WEEKLY" | "YEARLY";
  generated_at: Date;
  period_start: string;
  period_end: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ConnectionFactory = () => Promise<PoolConnection>;

async function listHistory<T>(
  input: HeldHistoryInput,
  capability: "VIEW_PREVIOUS_ENTRIES" | "VIEW_SAVED_REPORT",
  execute: (connection: PoolConnection, cutoff: Date | null) => Promise<T[]>,
  getConnection: ConnectionFactory
): Promise<HeldHistoryResult<T>> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_HOLD_HISTORY_API_ENABLED !== "true") {
    throw new HeldHistoryError("HOLD_HISTORY_DISABLED");
  }
  if (!uuid.test(input.userId) || !uuid.test(input.businessId)) {
    throw new HeldHistoryError("INVALID_HISTORY_REFERENCE", 400);
  }
  const connection = await getConnection();
  let started = false;
  try {
    await connection.beginTransaction();
    started = true;
    // Hold-state transitions must use the same business lock ordering.
    const business = await findCheckoutBusinessForUpdate(connection, input.businessId);
    if (!business) throw new HeldHistoryError("BUSINESS_ACCESS_DENIED");

    const requiredPermission = capability === "VIEW_PREVIOUS_ENTRIES"
      ? "transactions.read" : "reports.read";
    const [permissions] = await connection.execute<PermissionRow[]>(
      [
        "SELECT 1 AS allowed FROM business_memberships bm",
        "JOIN users u ON u.id = bm.user_id AND u.status = 'ACTIVE'",
        "JOIN roles r ON r.id = bm.role_id AND r.business_id = bm.business_id",
        "JOIN role_permissions rp ON rp.role_id = r.id",
        "JOIN permissions p ON p.id = rp.permission_id",
        "WHERE bm.business_id = ? AND bm.user_id = ? AND bm.status = 'ACTIVE'",
        "AND p.`key` = ? LIMIT 1",
      ].join(" "),
      [input.businessId, input.userId, requiredPermission]
    );
    if (permissions.length !== 1) {
      throw new HeldHistoryError("HISTORY_PERMISSION_DENIED");
    }
    const [subscriptions] = await connection.execute<SubscriptionRow[]>(
      [
        "SELECT bs.status, bs.held_at FROM businesses b",
        "JOIN business_subscriptions bs ON bs.id = b.current_subscription_id",
        "AND bs.business_id = b.id WHERE b.id = ? FOR UPDATE",
      ].join(" "),
      [input.businessId]
    );
    const subscription = subscriptions[0];
    if (!subscription) throw new HeldHistoryError("SUBSCRIPTION_ACCESS_LOCKED");
    // Metadata listing has no individual saved-report object yet. Check
    // access mode using dashboard capability after reports.read permission;
    // the SQL cutoff ensures only pre-hold report IDs can be listed.
    const accessCapability: BusinessCapability =
      capability === "VIEW_SAVED_REPORT" ? "VIEW_DASHBOARD" : capability;
    const decision = decideSubscriptionCapability({
      businessStatus: business.status as SubscriptionAccessState["businessStatus"],
      currentSubscriptionStatus: subscription.status,
      hasAuthorizedMembership: true,
    }, accessCapability);
    if (!decision.allowed || decision.mode === "LOCKED") {
      throw new HeldHistoryError(decision.code);
    }
    const mode = decision.mode as Exclude<AccessMode, "LOCKED">;
    let cutoff: Date | null = null;
    if (mode === "HOLD") {
      cutoff = subscription.held_at;
      if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime()) ||
          cutoff.getTime() > Date.now()) {
        throw new HeldHistoryError("REVIEWED_HOLD_TIMESTAMP_REQUIRED");
      }
    }

    const items = await execute(connection, cutoff);
    await connection.commit();
    started = false;
    return {
      mode,
      items,
      limitedTo: 100,
      newEntryAllowed: false,
      reportGenerationAllowed: false,
    };
  } catch (error) {
    if (started) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function listPreviousEntries(
  input: HeldHistoryInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<HeldHistoryResult<PreviousEntry>> {
  return listHistory(input, "VIEW_PREVIOUS_ENTRIES", async (connection, cutoff) => {
    const [rows] = await connection.execute<EntryRow[]>(
      [
        "SELECT id, transaction_type, amount_lkr, category, description,",
        "DATE_FORMAT(occurred_on, '%Y-%m-%d') AS occurred_on, created_at, version",
        "FROM cash_transactions WHERE business_id = ?",
        cutoff ? "AND created_at < ?" : "",
        "ORDER BY occurred_on DESC, id DESC LIMIT 100",
      ].join(" "),
      cutoff ? [input.businessId, cutoff] : [input.businessId]
    );
    return rows.map(row => ({
      id: row.id,
      type: row.transaction_type,
      amountLkr: String(row.amount_lkr),
      category: row.category,
      description: row.description,
      occurredOn: row.occurred_on,
      createdAt: row.created_at,
      version: row.version,
    }));
  }, getConnection);
}

export function listPreviouslyGeneratedReports(
  input: HeldHistoryInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<HeldHistoryResult<PreviousReport>> {
  return listHistory(input, "VIEW_SAVED_REPORT", async (connection, cutoff) => {
    const [rows] = await connection.execute<ReportRow[]>(
      [
        "SELECT id, report_type, generated_at,",
        "DATE_FORMAT(period_start, '%Y-%m-%d') AS period_start,",
        "DATE_FORMAT(period_end, '%Y-%m-%d') AS period_end",
        "FROM archived_report_snapshots WHERE business_id = ?",
        cutoff ? "AND generated_at <= ?" : "",
        "ORDER BY generated_at DESC, id DESC LIMIT 100",
      ].join(" "),
      cutoff ? [input.businessId, cutoff] : [input.businessId]
    );
    return rows.map(row => ({
      id: row.id,
      type: row.report_type,
      generatedAt: row.generated_at,
      periodStart: row.period_start,
      periodEnd: row.period_end,
    }));
  }, getConnection);
}
