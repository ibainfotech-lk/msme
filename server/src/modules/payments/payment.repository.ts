import type {
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";

import pool from "../../config/database";

export interface PaymentCheckoutOrderRow extends RowDataPacket {
  id: string;
  business_id: string;
  plan_id: string;
  status: string;
  amount_lkr: string;
  gateway_order_id: string | null;
  expires_at: Date | null;
  is_expired: number;
}

export interface PlatformPaymentRow extends RowDataPacket {
  id: string;
  business_id: string;
  checkout_order_id: string;
  idempotency_key: string;
  gateway: string;
  gateway_transaction_id: string | null;
  amount_lkr: string;
  status: string;
  verified_at: Date | null;
  initiation_status: "RESERVED" | "INITIATING" | "INITIATED" | "UNKNOWN" | "FAILED";
  merchant_reference: string | null;
  gateway_order_id: string | null;
  initiation_started_at: Date | null;
  initiation_completed_at: Date | null;
}

export async function getPaymentConnection(): Promise<PoolConnection> {
  return pool.getConnection();
}

export async function findPaymentCheckoutOrderForUpdate(
  connection: PoolConnection,
  checkoutOrderId: string,
  businessId: string
): Promise<PaymentCheckoutOrderRow | null> {
  const [rows] = await connection.execute<PaymentCheckoutOrderRow[]>(
    `SELECT
       id,
       business_id,
       plan_id,
       status,
       amount_lkr,
       gateway_order_id,
       expires_at,
       CASE
         WHEN expires_at IS NOT NULL
          AND expires_at <= UTC_TIMESTAMP(3)
         THEN 1
         ELSE 0
       END AS is_expired
     FROM checkout_orders
     WHERE id = ?
       AND business_id = ?
     LIMIT 1
     FOR UPDATE`,
    [checkoutOrderId, businessId]
  );

  return rows[0] ?? null;
}

export async function findPaymentByCheckoutOrder(
  connection: PoolConnection,
  checkoutOrderId: string
): Promise<PlatformPaymentRow[]> {
  const [rows] = await connection.execute<PlatformPaymentRow[]>(
    `SELECT
       id,
       business_id,
       checkout_order_id,
       idempotency_key,
       gateway,
       gateway_transaction_id,
       amount_lkr,
       status,
       verified_at,
       initiation_status,
       merchant_reference,
       gateway_order_id,
       initiation_started_at,
       initiation_completed_at
     FROM platform_payment_transactions
     WHERE checkout_order_id = ?
     ORDER BY created_at DESC`,
    [checkoutOrderId]
  );

  return rows;
}

export async function findPaymentByGatewayTransaction(
  connection: PoolConnection,
  gateway: string,
  gatewayTransactionId: string
): Promise<PlatformPaymentRow | null> {
  const [rows] = await connection.execute<PlatformPaymentRow[]>(
    `SELECT
       id,
       business_id,
       checkout_order_id,
       idempotency_key,
       gateway,
       gateway_transaction_id,
       amount_lkr,
       status,
       verified_at,
       initiation_status,
       merchant_reference,
       gateway_order_id,
       initiation_started_at,
       initiation_completed_at
     FROM platform_payment_transactions
     WHERE gateway = ?
       AND gateway_transaction_id = ?
     LIMIT 1`,
    [gateway, gatewayTransactionId]
  );

  return rows[0] ?? null;
}

export interface InsertPendingPlatformPaymentInput {
  id: string;
  businessId: string;
  checkoutOrderId: string;
  idempotencyKey: string;
  gateway: string;
  amountLkr: string;
  merchantReference: string;
}

export async function insertPendingPlatformPayment(
  connection: PoolConnection,
  input: InsertPendingPlatformPaymentInput
): Promise<void> {
  await connection.execute(
    `INSERT INTO platform_payment_transactions (
       id,
       business_id,
       checkout_order_id,
       idempotency_key,
       gateway,
       gateway_transaction_id,
       amount_lkr,
       status,
       initiation_status,
       merchant_reference,
       created_at,
       updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, NULL, ?, 'PENDING',
       'RESERVED', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
     )`,
    [
      input.id,
      input.businessId,
      input.checkoutOrderId,
      input.idempotencyKey,
      input.gateway,
      input.amountLkr,
      input.merchantReference
    ]
  );
}

export async function markCheckoutOrderProcessing(
  connection: PoolConnection,
  checkoutOrderId: string,
  businessId: string
): Promise<boolean> {
  const [result] = await connection.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE checkout_orders
     SET status = 'PROCESSING',
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?
       AND business_id = ?
       AND status = 'PENDING'
       AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(3))`,
    [checkoutOrderId, businessId]
  );

  return result.affectedRows === 1;
}

/**
 * Move a reserved payment attempt to INITIATING.
 *
 * Call inside a database transaction and commit before
 * contacting an external payment gateway.
 */
export async function markPaymentInitiating(
  connection: PoolConnection,
  paymentId: string,
  businessId: string
): Promise<boolean> {
  const [result] = await connection.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE platform_payment_transactions
     SET initiation_status = 'INITIATING',
         initiation_started_at = UTC_TIMESTAMP(3),
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?
       AND business_id = ?
       AND initiation_status = 'RESERVED'
       AND status = 'PENDING'
       AND merchant_reference IS NOT NULL`,
    [paymentId, businessId]
  );

  return result.affectedRows === 1;
}

/**
 * Record a successful gateway initiation.
 *
 * This does not mark the payment as SUCCEEDED.
 * Payment verification is a separate operation.
 */
export async function markPaymentInitiated(
  connection: PoolConnection,
  paymentId: string,
  businessId: string,
  gatewayOrderId: string
): Promise<boolean> {
  const [result] = await connection.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE platform_payment_transactions
     SET initiation_status = 'INITIATED',
         gateway_order_id = ?,
         initiation_completed_at = UTC_TIMESTAMP(3),
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?
       AND business_id = ?
       AND initiation_status = 'INITIATING'
       AND status = 'PENDING'
       AND merchant_reference IS NOT NULL
       AND gateway_order_id IS NULL`,
    [gatewayOrderId, paymentId, businessId]
  );

  return result.affectedRows === 1;
}

/**
 * Mark an ambiguous initiation outcome.
 *
 * UNKNOWN must be reconciled with the gateway.
 * Do not automatically initiate another charge.
 */
export async function markPaymentInitiationUnknown(
  connection: PoolConnection,
  paymentId: string,
  businessId: string
): Promise<boolean> {
  const [result] = await connection.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE platform_payment_transactions
     SET initiation_status = 'UNKNOWN',
         initiation_completed_at = UTC_TIMESTAMP(3),
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?
       AND business_id = ?
       AND initiation_status = 'INITIATING'
       AND status = 'PENDING'`,
    [paymentId, businessId]
  );

  return result.affectedRows === 1;
}

/**
 * Record a definitively confirmed initiation failure.
 *
 * Never use this function for a timeout or an ambiguous
 * gateway response. Such outcomes must be marked UNKNOWN
 * and reconciled before another attempt.
 *
 * The payment outcome status remains PENDING here.
 * Final payment status handling is a separate workflow.
 */
export async function markPaymentInitiationFailed(
  connection: PoolConnection,
  paymentId: string,
  businessId: string
): Promise<boolean> {
  const [result] = await connection.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE platform_payment_transactions
     SET initiation_status = 'FAILED',
         initiation_completed_at = UTC_TIMESTAMP(3),
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?
       AND business_id = ?
       AND initiation_status = 'INITIATING'
       AND status = 'PENDING'
       AND merchant_reference IS NOT NULL
       AND gateway_order_id IS NULL`,
    [paymentId, businessId]
  );

  return result.affectedRows === 1;
}

/**
 * Retrieve a payment attempt with an exclusive row lock.
 *
 * Must be called inside an active database transaction.
 * The caller must commit or roll back to release the lock.
 */
export async function findPaymentByIdForUpdate(
  connection: PoolConnection,
  paymentId: string,
  businessId: string
): Promise<PlatformPaymentRow | null> {
  const [rows] = await connection.execute<PlatformPaymentRow[]>(
    `SELECT
       id,
       business_id,
       checkout_order_id,
       idempotency_key,
       gateway,
       gateway_transaction_id,
       amount_lkr,
       status,
       verified_at,
       initiation_status,
       merchant_reference,
       gateway_order_id,
       initiation_started_at,
       initiation_completed_at
     FROM platform_payment_transactions
     WHERE id = ?
       AND business_id = ?
     LIMIT 1
     FOR UPDATE`,
    [paymentId, businessId]
  );

  return rows[0] ?? null;
}

/**
 * Check billing.manage permission for a business.
 *
 * Use within the same transaction as payment reservation
 * or payment initiation.
 *
 * The caller is responsible for authenticating the user.
 */
export async function hasPaymentBillingPermission(
  connection: PoolConnection,
  businessId: string,
  userId: string
): Promise<boolean> {
  interface PaymentAuthorizationRow extends RowDataPacket {
    authorized: number;
  }

  const [rows] = await connection.execute<
    PaymentAuthorizationRow[]
  >(
    `SELECT 1 AS authorized
     FROM business_memberships bm
     INNER JOIN users u
       ON u.id = bm.user_id
     INNER JOIN roles r
       ON r.id = bm.role_id
       AND r.business_id = bm.business_id
     INNER JOIN role_permissions rp
       ON rp.role_id = r.id
     INNER JOIN permissions p
       ON p.id = rp.permission_id
     WHERE bm.business_id = ?
       AND bm.user_id = ?
       AND bm.status = 'ACTIVE'
       AND u.status = 'ACTIVE'
       AND p.\`key\` = 'billing.manage'
     LIMIT 1`,
    [businessId, userId]
  );

  return rows.length > 0;
}

/**
 * Persist the gateway order ID on a processing checkout.
 *
 * This must be called in the same database transaction
 * as markPaymentInitiated().
 *
 * Do not commit between the checkout and payment updates.
 * Do not overwrite a previously recorded gateway order ID.
 */
export async function setCheckoutGatewayOrderId(
  connection: PoolConnection,
  checkoutOrderId: string,
  businessId: string,
  gatewayOrderId: string
): Promise<boolean> {
  if (
    !gatewayOrderId ||
    gatewayOrderId.trim() !== gatewayOrderId ||
    gatewayOrderId.length > 191
  ) {
    return false;
  }

  const [result] = await connection.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE checkout_orders
     SET gateway_order_id = ?,
         updated_at = UTC_TIMESTAMP(3)
     WHERE id = ?
       AND business_id = ?
       AND status = 'PROCESSING'
       AND gateway_order_id IS NULL`,
    [gatewayOrderId, checkoutOrderId, businessId]
  );

  return result.affectedRows === 1;
}