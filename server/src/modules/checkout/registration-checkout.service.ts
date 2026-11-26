import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../../config/database";
import type { PreferredLanguage, RegistrationType } from "../../services/registration.service";
import { insertCheckoutOrder } from "../checkout/checkout.repository";
import { registrationCheckoutEmailSchema } from "./registration-checkout.schema";
import { hasValidRegistrationLegalAgreement, REGISTRATION_TERMS_VERSION, REGISTRATION_PRIVACY_VERSION } from "./registration-legal.policy";

/**
 * Development-only, verified-OTP prepayment registration.
 * User/business/owner permission/membership/checkout creation is one transaction.
 * All entities remain PENDING until a trusted payment settlement commits.
 * Not a free-trial or promotion-code endpoint.
 */
export class RegistrationCheckoutError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RegistrationCheckoutError";
  }
}

export interface RegistrationCheckoutInput {
  phone: string;
  fullName: string;
  email: string;
  businessName: string;
  registrationType: RegistrationType;
  preferredLanguage: PreferredLanguage;
  planCode: string;
  idempotencyKey: string;
  termsAccepted: boolean;
  privacyAcknowledged: boolean;
  termsVersion: string;
  privacyVersion: string;
}

export interface RegistrationCheckoutResult {
  userId: string;
  businessId: string;
  checkoutOrderId: string;
  planCode: string;
  amountLkr: string;
  expiresAt: Date;
}

interface PlanRow extends RowDataPacket {
  id: string;
  code: string;
  price_lkr: string;
  billing_interval: string;
  trial_days: number;
  is_active: number;
}

interface ExistingUserRow extends RowDataPacket {
  id: string;
}

interface ExistingOrderRow extends RowDataPacket {
  id: string;
}

type ConnectionFactory = () => Promise<PoolConnection>;

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ER_DUP_ENTRY"
  );
}

const priceFormat = /^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/;

/**
 * Fixed, audited registration-owner permission baseline. Later modules must
 * not silently expand new owners' privileges through the global permission
 * catalogue (especially taxes.manage). Additions need explicit review.
 */
const registrationOwnerPermissionKeys = [
  "billing.manage", "business.manage", "business.read",
  "invoices.manage", "invoices.read", "members.manage", "members.read",
  "reports.read", "transactions.create", "transactions.delete",
  "transactions.read", "transactions.update",
] as const;

export async function createRegistrationCheckout(
  input: RegistrationCheckoutInput,
  getConnection: ConnectionFactory = () => pool.getConnection()
): Promise<RegistrationCheckoutResult> {
  if (process.env.NODE_ENV !== "development") {
    throw new RegistrationCheckoutError(
      403, "REGISTRATION_CHECKOUT_DISABLED",
      "Prepayment registration is not available in this environment."
    );
  }

  // Defensive validation for internal service callers as well as HTTP requests.
  // An email address is contact information, not verified proof of business identity.
  const parsedEmail = registrationCheckoutEmailSchema.safeParse(input.email);
  if (!parsedEmail.success) {
    throw new RegistrationCheckoutError(
      400, "INVALID_REGISTRATION_EMAIL", "Enter a valid email address."
    );
  }
  const normalizedEmail = parsedEmail.data;

  if (!hasValidRegistrationLegalAgreement(input)) {
    throw new RegistrationCheckoutError(
      400, "LEGAL_ACCEPTANCE_REQUIRED",
      "Review and explicitly agree to the current Terms and acknowledge the Privacy Notice."
    );
  }

  const connection = await getConnection();
  let started = false;

  const userId = randomUUID();
  const businessId = randomUUID();
  const roleId = randomUUID();
  const membershipId = randomUUID();
  const checkoutOrderId = randomUUID();

  try {
    await connection.beginTransaction();
    started = true;

    const [existingOrder] = await connection.execute<ExistingOrderRow[]>(
      "SELECT id FROM checkout_orders WHERE idempotency_key = ? LIMIT 1",
      [input.idempotencyKey]
    );
    if (existingOrder.length) {
      throw new RegistrationCheckoutError(
        409, "IDEMPOTENCY_KEY_ALREADY_USED",
        "This registration request has already been submitted. Sign in using OTP to resume checkout."
      );
    }

    const [plans] = await connection.execute<PlanRow[]>(
      [
        "SELECT id, code, price_lkr, billing_interval, trial_days, is_active",
        "FROM subscription_plans WHERE code = ? LIMIT 1",
      ].join(" "),
      [input.planCode]
    );

    const plan = plans[0];
    if (
      !plan ||
      Number(plan.is_active) !== 1 ||
      plan.billing_interval !== "MONTHLY" ||
      Number(plan.trial_days) !== 0 ||
      typeof plan.price_lkr !== "string" ||
      !priceFormat.test(plan.price_lkr) ||
      plan.price_lkr === "0.00"
    ) {
      throw new RegistrationCheckoutError(
        422, "PLAN_NOT_ELIGIBLE_FOR_PAID_CHECKOUT",
        "The plan is unavailable for paid registration. Trial and promotion plans are handled separately."
      );
    }

    const [existingUsers] = await connection.execute<ExistingUserRow[]>(
      "SELECT id FROM users WHERE phone = ? LIMIT 1",
      [input.phone]
    );
    if (existingUsers.length) {
      throw new RegistrationCheckoutError(
        409, "PHONE_ALREADY_REGISTERED",
        "This phone number already has an account. Sign in using OTP to resume checkout."
      );
    }

    await connection.execute(
      [
        "INSERT INTO users",
        "(id, phone, email, full_name, preferred_language, phone_verified_at, status, updated_at)",
        "VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), 'ACTIVE', UTC_TIMESTAMP(3))",
      ].join(" "),
      [userId, input.phone, normalizedEmail, input.fullName, input.preferredLanguage]
    );

    await connection.execute(
      [
        "INSERT INTO businesses",
        "(id, name, registration_type, status, updated_at)",
        "VALUES (?, ?, ?, 'PENDING', UTC_TIMESTAMP(3))",
      ].join(" "),
      [businessId, input.businessName, input.registrationType]
    );

    await connection.execute(
      [
        "INSERT INTO roles",
        "(id, business_id, name, is_system_role, updated_at)",
        "VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))",
      ].join(" "),
      [roleId, businessId]
    );

    // Grant only this registration workflow's reviewed baseline permissions.
    // A new global permission is never implicitly assigned to all owners.
    const placeholders = registrationOwnerPermissionKeys.map(() => "?").join(",");
    const [permissions] = await connection.execute<ResultSetHeader>(
      [
        "INSERT INTO role_permissions (role_id, permission_id)",
        "SELECT ?, p.id FROM permissions p",
        "WHERE p.`key` IN (" + placeholders + ")",
      ].join(" "),
      [roleId, ...registrationOwnerPermissionKeys]
    );
    if (permissions.affectedRows !== registrationOwnerPermissionKeys.length) {
      throw new RegistrationCheckoutError(
        503, "OWNER_PERMISSIONS_UNAVAILABLE",
        "Owner permissions have not been initialized."
      );
    }

    await connection.execute(
      [
        "INSERT INTO business_memberships",
        "(id, business_id, user_id, role_id, status, updated_at)",
        "VALUES (?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3))",
      ].join(" "),
      [membershipId, businessId, userId, roleId]
    );

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await insertCheckoutOrder(connection, {
      id: checkoutOrderId,
      businessId,
      planId: plan.id,
      amountLkr: plan.price_lkr,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    });

    // Store agreement proof in the SAME transaction as the pending registration.
    // The server, not the browser, supplies authoritative document versions and time.
    await connection.execute(
      [
        "INSERT INTO registration_legal_acceptances",
        "(id, user_id, business_id, checkout_order_id, terms_version,",
        "privacy_notice_version, acceptance_language, accepted_at)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
      ].join(" "),
      [randomUUID(), userId, businessId, checkoutOrderId,
       REGISTRATION_TERMS_VERSION, REGISTRATION_PRIVACY_VERSION,
       input.preferredLanguage]
    );

    await connection.commit();
    started = false;

    return {
      userId,
      businessId,
      checkoutOrderId,
      planCode: plan.code,
      amountLkr: plan.price_lkr,
      expiresAt,
    };
  } catch (error) {
    if (started) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("[REGISTRATION CHECKOUT] Rollback failed:", rollbackError);
      }
    }

    if (duplicateKey(error)) {
      throw new RegistrationCheckoutError(
        409, "REGISTRATION_CONFLICT",
        "Registration has already been submitted. Sign in using OTP to resume."
      );
    }

    throw error;
  } finally {
    connection.release();
  }
}
