import { createHash, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPaymentConnection } from "./payment.repository";

import {
  assessPaymentReconciliationEvidence,
  type ExpectedPaymentEvidence,
  type ReportedPaymentEvidence,
  type EvidenceClassification,
} from "./payment-reconciliation-evidence.policy";

export interface StoreReconciliationEvidenceInput {
  paymentId: string;
  reported: ReportedPaymentEvidence;

  // Original bytes supplied by an internal adapter.
  // Do not accept this directly from a public request.
  rawPayload: Buffer;

  webhookEventId?: string | null;
}

export interface StoreReconciliationEvidenceResult {
  evidenceId: string;
  replayed: boolean;
  assessment: EvidenceClassification;
}

interface PaymentIdentityRow extends RowDataPacket {
  id: string;
  business_id: string;
  checkout_order_id: string;
  gateway: string;
  merchant_reference: string | null;
  amount_lkr: string;
  checkout_amount_lkr: string;
}

interface ExistingEvidenceRow extends RowDataPacket {
  id: string;
  payment_id: string;
  webhook_event_id: string | null;
  gateway: string;
  source: string;
  source_reference: string;
  observed_at: Date;
  claimed_business_id: string;
  claimed_checkout_order_id: string;
  merchant_reference: string;
  amount_lkr: string;
  currency: string;
  gateway_order_id: string | null;
  gateway_transaction_id: string | null;
  outcome: string;
  payload_sha256: string;
  assessment: EvidenceClassification;
}

function validReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 191 &&
    value.trim() === value
  );
}

function validOptionalReference(value: unknown): boolean {
  return value === null || validReference(value);
}

function validateInput(input: StoreReconciliationEvidenceInput): Date {
  const r = input.reported;

  if (
    !validReference(input.paymentId) ||
    !Buffer.isBuffer(input.rawPayload) ||
    input.rawPayload.length === 0 ||
    input.rawPayload.length > 1024 * 1024 ||
    !r ||
    !["MOCK", "COMMERCIAL_BANK"].includes(r.gateway) ||
    ![
      "PROVIDER_STATUS_QUERY",
      "WEBHOOK_REPORT",
      "MANUAL_BANK_RECORD",
    ].includes(r.source) ||
    !validReference(r.sourceReference) ||
    !validReference(r.businessId) ||
    !validReference(r.checkoutOrderId) ||
    !validReference(r.merchantReference) ||
    !/^(0|[1-9]\d{0,11})\.\d{2}$/.test(r.amountLkr) ||
    r.amountLkr === "0.00" ||
    r.currency !== "LKR" ||
    !validOptionalReference(r.gatewayOrderId) ||
    !validOptionalReference(r.gatewayTransactionId) ||
    ![
      "PENDING", "SUCCEEDED", "FAILED",
      "CANCELLED", "NOT_FOUND", "INCONCLUSIVE",
    ].includes(r.outcome)
  ) {
    throw new Error("INVALID_RECONCILIATION_EVIDENCE");
  }

  const webhookEventId = input.webhookEventId ?? null;

  if (
    (r.source === "WEBHOOK_REPORT" &&
      !validReference(webhookEventId)) ||
    (r.source !== "WEBHOOK_REPORT" &&
      webhookEventId !== null)
  ) {
    throw new Error("INVALID_RECONCILIATION_WEBHOOK_LINK");
  }

  if (
    typeof r.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      r.observedAt
    )
  ) {
    throw new Error("INVALID_RECONCILIATION_OBSERVED_AT");
  }

  const observedAt = new Date(r.observedAt);

  if (
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.toISOString() !== r.observedAt
  ) {
    throw new Error("INVALID_RECONCILIATION_OBSERVED_AT");
  }

  return observedAt;
}

function sameEvidence(
  row: ExistingEvidenceRow,
  input: StoreReconciliationEvidenceInput,
  observedAt: Date,
  hash: string
): boolean {
  const r = input.reported;

  return (
    row.payment_id === input.paymentId &&
    row.webhook_event_id === (input.webhookEventId ?? null) &&
    row.gateway === r.gateway &&
    row.source === r.source &&
    row.source_reference === r.sourceReference &&
    new Date(row.observed_at).getTime() === observedAt.getTime() &&
    row.claimed_business_id === r.businessId &&
    row.claimed_checkout_order_id === r.checkoutOrderId &&
    row.merchant_reference === r.merchantReference &&
    String(row.amount_lkr) === r.amountLkr &&
    row.currency === r.currency &&
    row.gateway_order_id === r.gatewayOrderId &&
    row.gateway_transaction_id === r.gatewayTransactionId &&
    row.outcome === r.outcome &&
    row.payload_sha256 === hash
  );
}

/**
 * INTERNAL, APPEND-ONLY EVIDENCE STORAGE.
 *
 * - Every new report is UNVERIFIED.
 * - No existing evidence is updated.
 * - Exact duplicate source references are replay-safe.
 * - Conflicting source references are rejected.
 * - No payment or subscription state is modified.
 *
 * This function is not a bank authentication adapter.
 * Do not expose it as a public API endpoint.
 */
export async function storeReconciliationEvidence(
  input: StoreReconciliationEvidenceInput
): Promise<StoreReconciliationEvidenceResult> {
  // Disable this unfinished workflow in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error("RECONCILIATION_STORAGE_NOT_ENABLED");
  }

  const observedAt = validateInput(input);
  const r = input.reported;

  const hash = createHash("sha256")
    .update(input.rawPayload)
    .digest("hex");

  const connection = await getPaymentConnection();

  try {
    const [payments] =
      await connection.execute<PaymentIdentityRow[]>(
        `SELECT
           ppt.id,
           ppt.business_id,
           ppt.checkout_order_id,
           ppt.gateway,
           ppt.merchant_reference,
           ppt.amount_lkr,
           co.amount_lkr AS checkout_amount_lkr
         FROM platform_payment_transactions ppt
         INNER JOIN checkout_orders co
           ON co.id = ppt.checkout_order_id
          AND co.business_id = ppt.business_id
         WHERE ppt.id = ?`,
        [input.paymentId]
      );

    if (payments.length !== 1) {
      throw new Error("RECONCILIATION_PAYMENT_NOT_FOUND");
    }

    const payment = payments[0];

    if (
      !validReference(payment.merchant_reference) ||
      !["MOCK", "COMMERCIAL_BANK"].includes(payment.gateway) ||
      String(payment.amount_lkr) !==
        String(payment.checkout_amount_lkr)
    ) {
      throw new Error("RECONCILIATION_PAYMENT_STATE_INVALID");
    }

    if (r.source === "WEBHOOK_REPORT") {
      const [events] = await connection.execute<RowDataPacket[]>(
        `SELECT gateway, gateway_event_id
         FROM payment_webhook_events
         WHERE id = ?`,
        [input.webhookEventId ?? null]
      );

      if (
        events.length !== 1 ||
        events[0].gateway !== r.gateway ||
        events[0].gateway_event_id !== r.sourceReference
      ) {
        throw new Error("RECONCILIATION_WEBHOOK_LINK_CONFLICT");
      }
    }

    const expected: ExpectedPaymentEvidence = {
      paymentId: payment.id,
      businessId: payment.business_id,
      checkoutOrderId: payment.checkout_order_id,
      gateway: payment.gateway as ExpectedPaymentEvidence["gateway"],
      merchantReference: payment.merchant_reference,
      amountLkr: String(payment.amount_lkr),
      currency: "LKR",
    };

    const assessment = assessPaymentReconciliationEvidence(
      expected,
      r
    );

    const id = randomUUID();

    try {
      const [inserted] =
        await connection.execute<ResultSetHeader>(
          `INSERT INTO payment_reconciliation_evidence (
             id,
             payment_id,
             webhook_event_id,
             gateway,
             source,
             source_reference,
             observed_at,
             received_at,
             claimed_business_id,
             claimed_checkout_order_id,
             merchant_reference,
             amount_lkr,
             currency,
             gateway_order_id,
             gateway_transaction_id,
             outcome,
             payload_sha256,
             assessment,
             assessment_reason,
             authentication_status,
             authenticated_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'UNVERIFIED', NULL
           )`,
          [
            id,
            input.paymentId,
            input.webhookEventId ?? null,
            r.gateway,
            r.source,
            r.sourceReference,
            observedAt,
            r.businessId,
            r.checkoutOrderId,
            r.merchantReference,
            r.amountLkr,
            r.currency,
            r.gatewayOrderId,
            r.gatewayTransactionId,
            r.outcome,
            hash,
            assessment.classification,
            assessment.reason,
          ]
        );

      if (inserted.affectedRows !== 1) {
        throw new Error("RECONCILIATION_EVIDENCE_INSERT_FAILED");
      }

      return {
        evidenceId: id,
        replayed: false,
        assessment: assessment.classification,
      };

    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;

      if (code !== "ER_DUP_ENTRY") {
        throw error;
      }

      // The unique constraint serializes concurrent submissions.
      // Read the stored record; NEVER overwrite it.
      const [existing] =
        await connection.execute<ExistingEvidenceRow[]>(
          `SELECT *
           FROM payment_reconciliation_evidence
           WHERE gateway = ?
             AND source = ?
             AND source_reference = ?`,
          [r.gateway, r.source, r.sourceReference]
        );

      if (
        existing.length !== 1 ||
        !sameEvidence(existing[0], input, observedAt, hash)
      ) {
        throw new Error(
          "RECONCILIATION_EVIDENCE_REPLAY_CONFLICT"
        );
      }

      return {
        evidenceId: existing[0].id,
        replayed: true,
        assessment: existing[0].assessment,
      };
    }

  } finally {
    connection.release();
  }
}