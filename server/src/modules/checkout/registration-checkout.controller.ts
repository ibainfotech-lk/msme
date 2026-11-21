import type { RequestHandler, Request } from "express";
import { createRegistrationCheckout, RegistrationCheckoutError } from "./registration-checkout.service";
import {
  registrationCheckoutBodySchema,
  registrationIdempotencyKeySchema,
} from "./registration-checkout.schema";

const phonePattern = /^\+[1-9]\d{7,14}$/;
const verificationWindowMs = 10 * 60 * 1000;

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate(error => error ? reject(error) : resolve())
  );
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.save(error => error ? reject(error) : resolve())
  );
}

export const registerCheckoutController: RequestHandler = async (req, res, next) => {
  // The OTP delivery provider, anti-abuse controls and real bank adapter
  // are not ready for production. Fail closed.
  if (process.env.NODE_ENV !== "development") {
    res.status(403).json({
      success: false,
      code: "REGISTRATION_CHECKOUT_DISABLED",
      message: "Registration checkout is unavailable in this environment.",
    });
    return;
  }

  const phone = req.session?.verifiedPhone;
  const verifiedAt = req.session?.verifiedPhoneAt;
  const age = typeof verifiedAt === "number" ? Date.now() - verifiedAt : -1;

  if (
    typeof phone !== "string" ||
    !phonePattern.test(phone) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > verificationWindowMs ||
    req.session.userId
  ) {
    res.status(401).json({
      success: false,
      code: "RECENT_PHONE_VERIFICATION_REQUIRED",
      message: "Verify your phone using a new OTP before registering.",
    });
    return;
  }

  const body = registrationCheckoutBodySchema.safeParse(req.body);
  const key = registrationIdempotencyKeySchema.safeParse(
    req.get("Idempotency-Key")
  );
  if (!body.success || !key.success) {
    res.status(400).json({
      success: false,
      code: "INVALID_REGISTRATION_CHECKOUT_REQUEST",
      message: "Valid registration fields, plan and Idempotency-Key are required.",
    });
    return;
  }

  try {
    const result = await createRegistrationCheckout({
      phone,
      fullName: body.data.full_name,
      businessName: body.data.business_name,
      registrationType: {
        sole_proprietor: "SOLE_PROPRIETOR",
        private_limited_company: "PRIVATE_LIMITED",
        community_organization: "COMMUNITY_ORGANIZATION",
      }[body.data.business_type] as
        "SOLE_PROPRIETOR" | "PRIVATE_LIMITED" | "COMMUNITY_ORGANIZATION",
      preferredLanguage: body.data.preferred_language,
      planCode: body.data.plan_code,
      idempotencyKey: key.data,
    });

    // A committed pending registration must not be rolled back when a
    // session-store error occurs. The customer can resume by OTP login.
    try {
      await regenerateSession(req);
      req.session.userId = result.userId;
      req.session.verifiedPhone = undefined;
      req.session.verifiedPhoneAt = undefined;
      await saveSession(req);
    } catch (error) {
      console.error("[REGISTRATION CHECKOUT] Session setup failed:", error);
      try {
        await new Promise<void>(resolve => {
          req.session.destroy(() => resolve());
        });
      } catch {
        // Ignore session cleanup errors; require fresh login.
      }
      res.clearCookie("noteto.sid", { path: "/" });
      res.status(503).json({
        success: false,
        code: "ACCOUNT_CREATED_LOGIN_REQUIRED",
        message: "Pending checkout was created, but sign-in failed. Verify your phone again and resume checkout; do not register again.",
      });
      return;
    }

    res.status(201).json({
      success: true,
      payment_required: true,
      user: {
        id: result.userId,
        phone_number: phone,
        full_name: body.data.full_name,
        preferred_language: body.data.preferred_language,
      },
      business: {
        id: result.businessId,
        status: "PENDING",
      },
      checkout: {
        id: result.checkoutOrderId,
        plan_code: result.planCode,
        amount_lkr: result.amountLkr,
        expires_at: result.expiresAt,
        status: "PENDING",
      },
    });
  } catch (error) {
    if (error instanceof RegistrationCheckoutError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    next(error);
  }
};
