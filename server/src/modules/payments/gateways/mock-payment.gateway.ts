import { randomUUID } from "node:crypto";

import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentGateway,
  PaymentGatewayStatus,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "./payment-gateway.types";

type MockPaymentRecord = {
  gatewayOrderId: string;
  checkoutOrderId: string;
  businessId: string;
  merchantReference: string;
  amountLkr: string;
  status: PaymentGatewayStatus;
  gatewayTransactionId: string | null;
};

export class MockPaymentGateway implements PaymentGateway {
  readonly provider = "MOCK" as const;

  private readonly payments = new Map<string, MockPaymentRecord>();
  private readonly merchantReferences = new Map<string, string>();

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Mock payment gateway is disabled in production.");
    }
  }

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentResult> {
    if (input.currency !== "LKR") {
      throw new Error("Mock gateway supports LKR only.");
    }

    if (
      !/^\d+\.\d{2}$/.test(input.amountLkr) ||
      Number(input.amountLkr) <= 0
    ) {
      throw new Error("Invalid mock payment amount.");
    }

    if (
      !input.merchantReference ||
      input.merchantReference.trim() !== input.merchantReference ||
      input.merchantReference.length > 191
    ) {
      throw new Error("Invalid mock merchant reference.");
    }

    const existingOrderId = this.merchantReferences.get(
      input.merchantReference
    );

    if (existingOrderId) {
      const existing = this.payments.get(existingOrderId);

      if (!existing) {
        throw new Error("Mock gateway reference index is inconsistent.");
      }

      if (
        existing.checkoutOrderId !== input.checkoutOrderId ||
        existing.businessId !== input.businessId ||
        existing.amountLkr !== input.amountLkr
      ) {
        throw new Error(
          "Merchant reference cannot be reused for different payment details."
        );
      }

      return {
        provider: this.provider,
        gatewayOrderId: existing.gatewayOrderId,
        status: existing.status,
        redirectUrl: null,
      };
    }

    const gatewayOrderId = `mock_order_${randomUUID()}`;

    this.payments.set(gatewayOrderId, {
      gatewayOrderId,
      checkoutOrderId: input.checkoutOrderId,
      businessId: input.businessId,
      merchantReference: input.merchantReference,
      amountLkr: input.amountLkr,
      status: "PENDING",
      gatewayTransactionId: null,
    });

    this.merchantReferences.set(
      input.merchantReference,
      gatewayOrderId
    );

    return {
      provider: this.provider,
      gatewayOrderId,
      status: "PENDING",
      redirectUrl: null,
    };
  }

  async verifyPayment(
    input: VerifyPaymentInput
  ): Promise<VerifyPaymentResult> {
    const payment = this.payments.get(input.gatewayOrderId);

    if (!payment) {
      throw new Error("Mock gateway order not found.");
    }

    return {
      provider: this.provider,
      gatewayOrderId: payment.gatewayOrderId,
      gatewayTransactionId: payment.gatewayTransactionId,
      status: payment.status,
      amountLkr: payment.amountLkr,
      currency: "LKR",
      verifiedAt: new Date(),
    };
  }

  /**
   * Internal development test helper.
   * Do not expose this method through a public API.
   */
  setTestOutcome(
    gatewayOrderId: string,
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED"
  ): void {
    const payment = this.payments.get(gatewayOrderId);

    if (!payment) {
      throw new Error("Mock gateway order not found.");
    }

    if (payment.status !== "PENDING") {
      throw new Error("Mock payment outcome is already finalized.");
    }

    payment.status = outcome;

    if (outcome === "SUCCEEDED") {
      payment.gatewayTransactionId = `mock_txn_${randomUUID()}`;
    }
  }
}
