export type PaymentGatewayProvider = "MOCK" | "COMMERCIAL_BANK";

export type PaymentGatewayStatus =
  | "PENDING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface InitiatePaymentInput {
  checkoutOrderId: string;
  businessId: string;
  merchantReference: string;
  amountLkr: string;
  currency: "LKR";
  description: string;
}

export interface InitiatePaymentResult {
  provider: PaymentGatewayProvider;
  gatewayOrderId: string;
  status: PaymentGatewayStatus;
  redirectUrl: string | null;
}

export interface VerifyPaymentInput {
  gatewayOrderId: string;
}

export interface VerifyPaymentResult {
  provider: PaymentGatewayProvider;
  gatewayOrderId: string;
  gatewayTransactionId: string | null;
  status: PaymentGatewayStatus;
  amountLkr: string;
  currency: "LKR";
  verifiedAt: Date;
}

export interface PaymentGateway {
  readonly provider: PaymentGatewayProvider;

  initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentResult>;

  verifyPayment(
    input: VerifyPaymentInput
  ): Promise<VerifyPaymentResult>;
}
