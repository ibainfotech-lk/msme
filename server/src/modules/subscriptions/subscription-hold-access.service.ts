import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import {
  decideSubscriptionCapability,
  type BusinessCapability,
  type FeatureAccessDecision,
  type SubscriptionAccessState,
} from "./subscription-hold-access.policy";

/**
 * F.16.5.4c INTERNAL: business-scoped hold-access decision.
 *
 * This service only checks a business, its CURRENT subscription, and role
 * permissions. It changes no records and is not connected to HTTP routes.
 * Future edit/report routes MUST load an existing resource from their own
 * tenant-scoped repository and supply its audited provenance separately.
 */
export class SubscriptionHoldAccessError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) {
    super(code);
    this.name = "SubscriptionHoldAccessError";
  }
}

export interface HoldAccessRequest {
  userId: string;
  businessId: string;
  capability: BusinessCapability;
}

interface StateRow extends RowDataPacket {
  business_status: SubscriptionAccessState["businessStatus"];
  subscription_status: SubscriptionAccessState["currentSubscriptionStatus"];
}
interface PermissionRow extends RowDataPacket { permitted: number }

type ConnectionFactory = () => Promise<PoolConnection>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const permissionByCapability: Record<BusinessCapability, string> = {
  VIEW_DASHBOARD: "business.read",
  VIEW_PROFILE: "business.read",
  EDIT_PROFILE: "business.manage",
  VIEW_PREVIOUS_ENTRIES: "transactions.read",
  EDIT_PREVIOUS_ENTRY: "transactions.update",
  VIEW_SAVED_REPORT: "reports.read",
  DOWNLOAD_SAVED_REPORT: "reports.read",
  VIEW_BILLING: "billing.manage",
  REQUEST_PAYMENT_REVIEW: "billing.manage",
  CREATE_INCOME: "transactions.create",
  CREATE_EXPENSE: "transactions.create",
  CREATE_INVOICE: "invoices.manage",
  GENERATE_REPORT: "reports.read",
  DELETE_ENTRY: "transactions.delete",
  CREATE_NEW_TRANSACTION: "transactions.create",
  MANAGE_USERS: "members.manage",
};

export async function evaluateBusinessHoldCapability(
  input: HoldAccessRequest,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<FeatureAccessDecision> {
  if (process.env.NODE_ENV !== "development" ||
      process.env.NOTETO_SUBSCRIPTION_HOLD_POLICY_ENABLED !== "true") {
    throw new SubscriptionHoldAccessError("HOLD_POLICY_DISABLED");
  }
  if (!uuid.test(input.userId) || !uuid.test(input.businessId) ||
      !Object.prototype.hasOwnProperty.call(permissionByCapability, input.capability)) {
    throw new SubscriptionHoldAccessError("INVALID_HOLD_POLICY_REFERENCE", 400);
  }

  const connection = await getConnection();
  try {
    const [rows] = await connection.execute<StateRow[]>(
      [
        "SELECT b.status AS business_status, bs.status AS subscription_status",
        "FROM businesses b",
        "JOIN business_memberships bm ON bm.business_id = b.id",
        "AND bm.user_id = ? AND bm.status = 'ACTIVE'",
        "JOIN users u ON u.id = bm.user_id AND u.status = 'ACTIVE'",
        "LEFT JOIN business_subscriptions bs",
        "ON bs.id = b.current_subscription_id AND bs.business_id = b.id",
        "WHERE b.id = ? LIMIT 1",
      ].join(" "),
      [input.userId, input.businessId]
    );
    if (rows.length !== 1) throw new SubscriptionHoldAccessError("BUSINESS_ACCESS_DENIED");

    const rolePermission = permissionByCapability[input.capability];
    const [permission] = await connection.execute<PermissionRow[]>(
      [
        "SELECT 1 AS permitted FROM business_memberships bm",
        "JOIN roles r ON r.id = bm.role_id AND r.business_id = bm.business_id",
        "JOIN role_permissions rp ON rp.role_id = r.id",
        "JOIN permissions p ON p.id = rp.permission_id",
        "WHERE bm.business_id = ? AND bm.user_id = ?",
        "AND bm.status = 'ACTIVE' AND p.`key` = ? LIMIT 1",
      ].join(" "),
      [input.businessId, input.userId, rolePermission]
    );
    if (permission.length === 0) throw new SubscriptionHoldAccessError("ROLE_PERMISSION_DENIED");

    // Resource-sensitive operations always require a separate audited
    // ownership/snapshot lookup. This endpoint cannot attest to one.
    return decideSubscriptionCapability({
      businessStatus: rows[0].business_status,
      currentSubscriptionStatus: rows[0].subscription_status,
      hasAuthorizedMembership: true,
    }, input.capability);
  } finally {
    connection.release();
  }
}
