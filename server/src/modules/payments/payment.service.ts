import { randomUUID } from "node:crypto";

import {
  findCheckoutBusinessForUpdate,
} from "../checkout/checkout.repository";

import {
  getPaymentConnection,
  findPaymentCheckoutOrderForUpdate,
  findPaymentByCheckoutOrder,
  insertPendingPlatformPayment,
  hasPaymentBillingPermission,
  findPaymentByIdForUpdate,
  markCheckoutOrderProcessing,
  markPaymentInitiating,
  setCheckoutGatewayOrderId,
  markPaymentInitiated,
  markPaymentInitiationUnknown,
  type PlatformPaymentRow,
} from "./payment.repository";

import type {
  PaymentGatewayProvider,
} from "./gateways/payment-gateway.types";

export class PaymentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export interface ReservePaymentInput {
  checkoutOrderId: string;
  businessId: string;
  userId: string;
  gateway: PaymentGatewayProvider;
}

export interface ReservePaymentResult {
  payment: PlatformPaymentRow;
  replayed: boolean;
}

export async function reservePayment(
  input: ReservePaymentInput
): Promise<ReservePaymentResult> {
  if (
    !input.checkoutOrderId ||
    !input.businessId ||
    !input.userId
  ) {
    throw new PaymentError(
      400,
      "INVALID_PAYMENT_REQUEST",
      "Checkout order, business, and authenticated user are required."
    );
  }

  if (
    input.gateway !== "MOCK" &&
    input.gateway !== "COMMERCIAL_BANK"
  ) {
    throw new PaymentError(
      400,
      "INVALID_PAYMENT_GATEWAY",
      "Unsupported payment gateway."
    );
  }

  if (
    input.gateway === "MOCK" &&
    process.env.NODE_ENV === "production"
  ) {
    throw new PaymentError(
      400,
      "MOCK_GATEWAY_DISABLED",
      "Mock payments are unavailable in production."
    );
  }

  const connection = await getPaymentConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // Match checkout creation's lock order: business first.
    const business = await findCheckoutBusinessForUpdate(
      connection,
      input.businessId
    );

    if (
      !business ||
      (business.status !== "PENDING" &&
       business.status !== "ACTIVE")
    ) {
      throw new PaymentError(
        403,
        "BUSINESS_ACCESS_DENIED",
        "Business access is not permitted."
      );
    }

    const order = await findPaymentCheckoutOrderForUpdate(
      connection,
      input.checkoutOrderId,
      input.businessId
    );

    if (!order) {
      throw new PaymentError(
        404,
        "CHECKOUT_ORDER_NOT_FOUND",
        "Checkout order not found."
      );
    }

    const authorized = await hasPaymentBillingPermission(
      connection,
      input.businessId,
      input.userId
    );

    if (!authorized) {
      throw new PaymentError(
        403,
        "BILLING_PERMISSION_DENIED",
        "Billing permission is required."
      );
    }

    const existingPayments = await findPaymentByCheckoutOrder(
      connection,
      input.checkoutOrderId
    );

    if (existingPayments.length > 1) {
      throw new PaymentError(
        409,
        "MULTIPLE_PAYMENT_ATTEMPTS",
        "Multiple payment attempts require reconciliation."
      );
    }

    if (existingPayments.length === 1) {
      const existing = existingPayments[0];

      if (
        existing.business_id !== input.businessId ||
        existing.gateway !== input.gateway
      ) {
        throw new PaymentError(
          409,
          "PAYMENT_CONFLICT",
          "An existing payment attempt conflicts with this request."
        );
      }

      if (existing.initiation_status === "UNKNOWN") {
        throw new PaymentError(
          409,
          "PAYMENT_RECONCILIATION_REQUIRED",
          "Payment initiation requires reconciliation."
        );
      }

      if (
        existing.initiation_status === "INITIATING" ||
        existing.initiation_status === "FAILED"
      ) {
        throw new PaymentError(
          409,
          "PAYMENT_INITIATION_UNAVAILABLE",
          "This payment attempt cannot be initiated again."
        );
      }

      if (
        existing.status !== "PENDING" ||
        (existing.initiation_status !== "RESERVED" &&
         existing.initiation_status !== "INITIATED")
      ) {
        throw new PaymentError(
          409,
          "PAYMENT_STATE_CONFLICT",
          "The existing payment is not eligible for reservation."
        );
      }

      if (
        String(existing.amount_lkr) !== String(order.amount_lkr)
      ) {
        throw new PaymentError(
          409,
          "PAYMENT_AMOUNT_MISMATCH",
          "Payment and checkout amounts do not match."
        );
      }

      if (existing.initiation_status === "RESERVED") {
        if (order.status !== "PENDING") {
          throw new PaymentError(
            409,
            "CHECKOUT_STATE_CONFLICT",
            "Checkout is not eligible for payment reservation."
          );
        }

        if (Number(order.is_expired) === 1) {
          throw new PaymentError(
            409,
            "CHECKOUT_EXPIRED",
            "Checkout order has expired."
          );
        }
      }

      if (existing.initiation_status === "INITIATED") {
        if (
          order.status !== "PROCESSING" ||
          !existing.gateway_order_id ||
          order.gateway_order_id !== existing.gateway_order_id
        ) {
          throw new PaymentError(
            409,
            "PAYMENT_GATEWAY_ORDER_CONFLICT",
            "Payment and checkout gateway states do not match."
          );
        }
      }

      await connection.commit();
      transactionStarted = false;

      return {
        payment: existing,
        replayed: true,
      };
    }

    if (order.status !== "PENDING") {
      throw new PaymentError(
        409,
        "CHECKOUT_NOT_PENDING",
        "Checkout order is not available for payment reservation."
      );
    }

    if (Number(order.is_expired) === 1) {
      throw new PaymentError(
        409,
        "CHECKOUT_EXPIRED",
        "Checkout order has expired."
      );
    }

    if (
      !/^\d+\.\d{2}$/.test(String(order.amount_lkr)) ||
      Number(order.amount_lkr) <= 0
    ) {
      throw new PaymentError(
        409,
        "INVALID_CHECKOUT_AMOUNT",
        "Checkout order amount is invalid."
      );
    }

    const paymentId = randomUUID();

    const merchantReference = `noteto_${randomUUID()}`;

    const idempotencyKey = `payment_${randomUUID()}`;

    await insertPendingPlatformPayment(connection, {
      id: paymentId,
      businessId: input.businessId,
      checkoutOrderId: input.checkoutOrderId,
      idempotencyKey,
      gateway: input.gateway,
      amountLkr: String(order.amount_lkr),
      merchantReference,
    });

    const payments = await findPaymentByCheckoutOrder(
      connection,
      input.checkoutOrderId
    );

    const created = payments.find(
      (payment) => payment.id === paymentId
    );

    if (!created) {
      throw new Error(
        "Reserved payment could not be retrieved."
      );
    }

    await connection.commit();
    transactionStarted = false;

    return {
      payment: created,
      replayed: false,
    };
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }

    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Atomically transition a reserved payment to INITIATING
 * and its checkout order to PROCESSING.
 *
 * This function makes no external gateway requests.
 * After commit, uncertain or interrupted initiation
 * must be reconciled rather than automatically retried.
 */
export interface BeginPaymentInitiationInput {
  paymentId: string;
  checkoutOrderId: string;
  businessId: string;
  userId: string;
}

export interface BeginPaymentInitiationResult {
  payment: PlatformPaymentRow;
  merchantReference: string;
}

export async function beginPaymentInitiation(
  input: BeginPaymentInitiationInput
): Promise<BeginPaymentInitiationResult> {
  if (
    !input.paymentId ||
    !input.checkoutOrderId ||
    !input.businessId ||
    !input.userId
  ) {
    throw new PaymentError(
      400,
      "INVALID_PAYMENT_INITIATION_REQUEST",
      "Payment, checkout, business and authenticated user are required."
    );
  }

  const connection = await getPaymentConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // Consistent lock order: business -> checkout -> payment.
    const business = await findCheckoutBusinessForUpdate(
      connection,
      input.businessId
    );

    if (
      !business ||
      (business.status !== "PENDING" &&
       business.status !== "ACTIVE")
    ) {
      throw new PaymentError(
        403,
        "BUSINESS_ACCESS_DENIED",
        "Business access is not permitted."
      );
    }

    const order = await findPaymentCheckoutOrderForUpdate(
      connection,
      input.checkoutOrderId,
      input.businessId
    );

    if (!order) {
      throw new PaymentError(
        404,
        "CHECKOUT_ORDER_NOT_FOUND",
        "Checkout order not found."
      );
    }

    const authorized = await hasPaymentBillingPermission(
      connection,
      input.businessId,
      input.userId
    );

    if (!authorized) {
      throw new PaymentError(
        403,
        "BILLING_PERMISSION_DENIED",
        "Billing permission is required."
      );
    }

    const payment = await findPaymentByIdForUpdate(
      connection,
      input.paymentId,
      input.businessId
    );

    if (
      !payment ||
      payment.checkout_order_id !== input.checkoutOrderId
    ) {
      throw new PaymentError(
        404,
        "PAYMENT_NOT_FOUND",
        "Payment attempt not found for this checkout."
      );
    }

    // Do not initiate if another attempt exists.
    const attempts = await findPaymentByCheckoutOrder(
      connection,
      input.checkoutOrderId
    );

    if (
      attempts.length !== 1 ||
      attempts[0].id !== payment.id
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_ATTEMPT_CONFLICT",
        "Checkout payment attempts require reconciliation."
      );
    }

    if (
      order.status !== "PENDING" ||
      order.gateway_order_id !== null
    ) {
      throw new PaymentError(
        409,
        "CHECKOUT_STATE_CONFLICT",
        "Checkout order is not ready for payment initiation."
      );
    }

    if (Number(order.is_expired) === 1) {
      throw new PaymentError(
        409,
        "CHECKOUT_EXPIRED",
        "Checkout order has expired."
      );
    }

    if (
      payment.status !== "PENDING" ||
      payment.initiation_status !== "RESERVED" ||
      payment.gateway_order_id !== null ||
      !payment.merchant_reference
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_STATE_CONFLICT",
        "Payment attempt is not eligible for initiation."
      );
    }

    if (
      String(payment.amount_lkr) !== String(order.amount_lkr)
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_AMOUNT_MISMATCH",
        "Payment amount does not match checkout amount."
      );
    }

    // Only the development mock gateway is supported here.
    // Commercial Bank initiation requires its own tested adapter.
    if (
      payment.gateway !== "MOCK" ||
      process.env.NODE_ENV === "production"
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_GATEWAY_NOT_READY",
        "Payment initiation is not enabled for this gateway."
      );
    }

    // Both changes must succeed within this transaction.
    const checkoutUpdated = await markCheckoutOrderProcessing(
      connection,
      input.checkoutOrderId,
      input.businessId
    );

    if (!checkoutUpdated) {
      throw new PaymentError(
        409,
        "CHECKOUT_TRANSITION_FAILED",
        "Checkout could not transition to processing."
      );
    }

    const paymentUpdated = await markPaymentInitiating(
      connection,
      payment.id,
      input.businessId
    );

    if (!paymentUpdated) {
      throw new PaymentError(
        409,
        "PAYMENT_TRANSITION_FAILED",
        "Payment could not transition to initiating."
      );
    }

    const updatedPayment = await findPaymentByIdForUpdate(
      connection,
      payment.id,
      input.businessId
    );

    if (
      !updatedPayment ||
      updatedPayment.initiation_status !== "INITIATING"
    ) {
      throw new Error(
        "Payment initiation transition could not be verified."
      );
    }

    await connection.commit();
    transactionStarted = false;

    return {
      payment: updatedPayment,
      merchantReference: payment.merchant_reference,
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Payment initiation rollback failed:",
          rollbackError
        );
      }
    }

    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Persist a confirmed gateway initiation response.
 *
 * INTERNAL ONLY: Call from trusted gateway orchestration.
 * Do not expose directly as a public API endpoint.
 *
 * Both gateway order ID updates are atomic.
 * This does not verify payment or activate subscriptions.
 *
 * Never reject an already-started gateway response merely
 * because the checkout expiry time has passed.
 */
export interface PersistPaymentInitiationInput {
  paymentId: string;
  checkoutOrderId: string;
  businessId: string;
  gateway: PaymentGatewayProvider;
  merchantReference: string;
  gatewayOrderId: string;
}

export interface PersistPaymentInitiationResult {
  payment: PlatformPaymentRow;
  replayed: boolean;
}

export async function persistPaymentInitiationResult(
  input: PersistPaymentInitiationInput
): Promise<PersistPaymentInitiationResult> {
  if (
    !input.paymentId ||
    !input.checkoutOrderId ||
    !input.businessId ||
    !input.merchantReference ||
    !input.gatewayOrderId ||
    input.merchantReference.trim() !== input.merchantReference ||
    input.gatewayOrderId.trim() !== input.gatewayOrderId ||
    input.merchantReference.length > 191 ||
    input.gatewayOrderId.length > 191
  ) {
    throw new PaymentError(
      400,
      "INVALID_GATEWAY_INITIATION_RESULT",
      "Invalid payment initiation result."
    );
  }

  // The real bank adapter has not been implemented or tested.
  if (
    input.gateway !== "MOCK" ||
    process.env.NODE_ENV === "production" ||
    !input.gatewayOrderId.startsWith("mock_order_")
  ) {
    throw new PaymentError(
      409,
      "PAYMENT_GATEWAY_NOT_READY",
      "Gateway result persistence is not enabled for this provider."
    );
  }

  const connection = await getPaymentConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // Consistent lock order: business -> checkout -> payment.
    // Do not check current business status here: a gateway
    // response may arrive after a business was suspended.
    const business = await findCheckoutBusinessForUpdate(
      connection,
      input.businessId
    );

    if (!business) {
      throw new PaymentError(
        404,
        "BUSINESS_NOT_FOUND",
        "Payment business not found."
      );
    }

    const order = await findPaymentCheckoutOrderForUpdate(
      connection,
      input.checkoutOrderId,
      input.businessId
    );

    if (!order) {
      throw new PaymentError(
        404,
        "CHECKOUT_ORDER_NOT_FOUND",
        "Checkout order not found."
      );
    }

    const payment = await findPaymentByIdForUpdate(
      connection,
      input.paymentId,
      input.businessId
    );

    if (
      !payment ||
      payment.checkout_order_id !== input.checkoutOrderId
    ) {
      throw new PaymentError(
        404,
        "PAYMENT_NOT_FOUND",
        "Payment attempt not found."
      );
    }

    const attempts = await findPaymentByCheckoutOrder(
      connection,
      input.checkoutOrderId
    );

    if (
      attempts.length !== 1 ||
      attempts[0].id !== payment.id
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_ATTEMPT_CONFLICT",
        "Checkout payment attempts require reconciliation."
      );
    }

    if (
      payment.gateway !== input.gateway ||
      payment.merchant_reference !== input.merchantReference ||
      String(payment.amount_lkr) !== String(order.amount_lkr)
    ) {
      throw new PaymentError(
        409,
        "GATEWAY_RESULT_CONFLICT",
        "Gateway result does not match the reserved payment."
      );
    }

    if (
      order.status !== "PROCESSING" ||
      payment.status !== "PENDING"
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_STATE_CONFLICT",
        "Checkout or payment is not in the expected state."
      );
    }

    // A previous commit may have succeeded even if its
    // acknowledgement did not reach the caller.
    if (payment.initiation_status === "INITIATED") {
      if (
        payment.gateway_order_id !== input.gatewayOrderId ||
        order.gateway_order_id !== input.gatewayOrderId
      ) {
        throw new PaymentError(
          409,
          "GATEWAY_ORDER_CONFLICT",
          "A different gateway order ID is already recorded."
        );
      }

      await connection.commit();
      transactionStarted = false;

      return {
        payment,
        replayed: true,
      };
    }

    if (
      payment.initiation_status !== "INITIATING" ||
      payment.gateway_order_id !== null ||
      order.gateway_order_id !== null
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_INITIATION_STATE_CONFLICT",
        "The payment cannot accept this initiation result."
      );
    }

    // Update checkout first, followed by payment.
    // Both writes remain inside this one transaction.
    const checkoutUpdated = await setCheckoutGatewayOrderId(
      connection,
      input.checkoutOrderId,
      input.businessId,
      input.gatewayOrderId
    );

    if (!checkoutUpdated) {
      throw new PaymentError(
        409,
        "CHECKOUT_GATEWAY_UPDATE_FAILED",
        "Gateway order ID could not be saved on checkout."
      );
    }

    const paymentUpdated = await markPaymentInitiated(
      connection,
      payment.id,
      input.businessId,
      input.gatewayOrderId
    );

    if (!paymentUpdated) {
      throw new PaymentError(
        409,
        "PAYMENT_GATEWAY_UPDATE_FAILED",
        "Gateway initiation could not be finalized."
      );
    }

    const updatedPayment = await findPaymentByIdForUpdate(
      connection,
      payment.id,
      input.businessId
    );

    if (
      !updatedPayment ||
      updatedPayment.initiation_status !== "INITIATED" ||
      updatedPayment.gateway_order_id !== input.gatewayOrderId
    ) {
      throw new Error(
        "Persisted gateway initiation state could not be verified."
      );
    }

    await connection.commit();
    transactionStarted = false;

    return {
      payment: updatedPayment,
      replayed: false,
    };

  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Gateway result persistence rollback failed:",
          rollbackError
        );
      }
    }

    throw error;

  } finally {
    connection.release();
  }
}

/**
 * Record an uncertain result from an attempted gateway initiation.
 *
 * INTERNAL ONLY. Never expose directly as a public route.
 *
 * Use only when a gateway request may have been processed,
 * but no reliable gateway order ID/outcome was obtained.
 *
 * UNKNOWN does not mean payment failure.
 * UNKNOWN must not trigger an automatic gateway retry.
 */
export interface RecordUncertainPaymentInitiationInput {
  paymentId: string;
  checkoutOrderId: string;
  businessId: string;
  gateway: PaymentGatewayProvider;
  merchantReference: string;
}

export interface RecordUncertainPaymentInitiationResult {
  payment: PlatformPaymentRow;
  replayed: boolean;
}

export async function recordUncertainPaymentInitiation(
  input: RecordUncertainPaymentInitiationInput
): Promise<RecordUncertainPaymentInitiationResult> {
  if (
    !input.paymentId ||
    !input.checkoutOrderId ||
    !input.businessId ||
    !input.merchantReference ||
    input.merchantReference.trim() !== input.merchantReference ||
    input.merchantReference.length > 191 ||
    !["MOCK", "COMMERCIAL_BANK"].includes(input.gateway)
  ) {
    throw new PaymentError(
      400,
      "INVALID_UNCERTAIN_INITIATION_REQUEST",
      "Invalid uncertain initiation request."
    );
  }

  if (
    input.gateway === "MOCK" &&
    process.env.NODE_ENV === "production"
  ) {
    throw new PaymentError(
      409,
      "MOCK_GATEWAY_DISABLED",
      "Mock gateway is disabled in production."
    );
  }

  const connection = await getPaymentConnection();
  let transactionStarted = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // Lock order: business -> checkout -> payment.
    const business = await findCheckoutBusinessForUpdate(
      connection,
      input.businessId
    );

    if (!business) {
      throw new PaymentError(
        404,
        "BUSINESS_NOT_FOUND",
        "Payment business not found."
      );
    }

    const order = await findPaymentCheckoutOrderForUpdate(
      connection,
      input.checkoutOrderId,
      input.businessId
    );

    if (!order) {
      throw new PaymentError(
        404,
        "CHECKOUT_ORDER_NOT_FOUND",
        "Checkout order not found."
      );
    }

    const payment = await findPaymentByIdForUpdate(
      connection,
      input.paymentId,
      input.businessId
    );

    if (
      !payment ||
      payment.checkout_order_id !== input.checkoutOrderId
    ) {
      throw new PaymentError(
        404,
        "PAYMENT_NOT_FOUND",
        "Payment attempt not found."
      );
    }

    const attempts = await findPaymentByCheckoutOrder(
      connection,
      input.checkoutOrderId
    );

    if (
      attempts.length !== 1 ||
      attempts[0].id !== payment.id
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_ATTEMPT_CONFLICT",
        "Payment attempts require reconciliation."
      );
    }

    if (
      payment.gateway !== input.gateway ||
      payment.merchant_reference !== input.merchantReference ||
      String(payment.amount_lkr) !== String(order.amount_lkr)
    ) {
      throw new PaymentError(
        409,
        "UNCERTAIN_INITIATION_CONFLICT",
        "Request does not match the original payment."
      );
    }

    // No gateway identifier or verified payment may exist.
    if (
      order.status !== "PROCESSING" ||
      order.gateway_order_id !== null ||
      payment.status !== "PENDING" ||
      payment.gateway_order_id !== null ||
      payment.gateway_transaction_id !== null ||
      payment.verified_at !== null
    ) {
      throw new PaymentError(
        409,
        "PAYMENT_STATE_CONFLICT",
        "Payment is not eligible for uncertain initiation recording."
      );
    }

    // Idempotent replay: UNKNOWN remains UNKNOWN.
    if (payment.initiation_status === "UNKNOWN") {
      await connection.commit();
      transactionStarted = false;

      return {
        payment,
        replayed: true,
      };
    }

    if (payment.initiation_status !== "INITIATING") {
      throw new PaymentError(
        409,
        "PAYMENT_INITIATION_STATE_CONFLICT",
        "Only an initiating payment can become UNKNOWN."
      );
    }

    const updated = await markPaymentInitiationUnknown(
      connection,
      payment.id,
      input.businessId
    );

    if (!updated) {
      throw new PaymentError(
        409,
        "UNKNOWN_TRANSITION_FAILED",
        "Could not record uncertain payment initiation."
      );
    }

    const updatedPayment = await findPaymentByIdForUpdate(
      connection,
      payment.id,
      input.businessId
    );

    if (
      !updatedPayment ||
      updatedPayment.initiation_status !== "UNKNOWN" ||
      updatedPayment.status !== "PENDING" ||
      updatedPayment.gateway_order_id !== null
    ) {
      throw new Error(
        "Uncertain initiation state verification failed."
      );
    }

    await connection.commit();
    transactionStarted = false;

    return {
      payment: updatedPayment,
      replayed: false,
    };

  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "Uncertain initiation rollback failed:",
          rollbackError
        );
      }
    }

    throw error;

  } finally {
    connection.release();
  }
}