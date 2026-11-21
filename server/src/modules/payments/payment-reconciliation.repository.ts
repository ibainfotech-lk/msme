import type { RowDataPacket } from "mysql2/promise";
import { getPaymentConnection } from "./payment.repository";

export type PaymentRecoveryReason =
  | "UNKNOWN"
  | "STALE_INITIATING"
  | "MISSING_START_TIME";

export interface PaymentInitiationRecoveryCandidate
  extends RowDataPacket {
  payment_id: string;
  business_id: string;
  checkout_order_id: string;
  gateway: "MOCK" | "COMMERCIAL_BANK";
  merchant_reference: string | null;
  initiation_status: "UNKNOWN" | "INITIATING";
  initiation_started_at: Date | null;
  payment_gateway_order_id: string | null;
  checkout_status: string | null;
  checkout_gateway_order_id: string | null;
  age_seconds: number | null;
  recovery_reason: PaymentRecoveryReason;
}

/**
 * INTERNAL READ-ONLY recovery inventory.
 *
 * No gateway calls, payment retries, updates or locks.
 * Returned data is sensitive operational information:
 * do not expose this function to an unauthenticated route.
 *
 * The five-minute threshold identifies candidates only.
 * It does not establish whether the gateway processed
 * an initiation request.
 */
export async function listPaymentInitiationRecoveryCandidates():
  Promise<PaymentInitiationRecoveryCandidate[]> {
  const connection = await getPaymentConnection();

  try {
    const [rows] = await connection.execute<
      PaymentInitiationRecoveryCandidate[]
    >(
      `SELECT
         ppt.id AS payment_id,
         ppt.business_id,
         ppt.checkout_order_id,
         ppt.gateway,
         ppt.merchant_reference,
         ppt.initiation_status,
         ppt.initiation_started_at,
         ppt.gateway_order_id AS payment_gateway_order_id,
         co.status AS checkout_status,
         co.gateway_order_id AS checkout_gateway_order_id,
         TIMESTAMPDIFF(
           SECOND,
           ppt.initiation_started_at,
           UTC_TIMESTAMP(3)
         ) AS age_seconds,
         CASE
           WHEN ppt.initiation_status = 'UNKNOWN'
             THEN 'UNKNOWN'
           WHEN ppt.initiation_started_at IS NULL
             THEN 'MISSING_START_TIME'
           ELSE 'STALE_INITIATING'
         END AS recovery_reason
       FROM platform_payment_transactions ppt
       LEFT JOIN checkout_orders co
         ON co.id = ppt.checkout_order_id
        AND co.business_id = ppt.business_id
       WHERE ppt.status = 'PENDING'
         AND (
           ppt.initiation_status = 'UNKNOWN'
           OR (
             ppt.initiation_status = 'INITIATING'
             AND (
               ppt.initiation_started_at IS NULL
               OR ppt.initiation_started_at <=
                  DATE_SUB(
                    UTC_TIMESTAMP(3),
                    INTERVAL 5 MINUTE
                  )
             )
           )
         )
       ORDER BY
         ppt.initiation_started_at ASC,
         ppt.id ASC
       LIMIT 100`
    );

    return rows;
  } finally {
    connection.release();
  }
}