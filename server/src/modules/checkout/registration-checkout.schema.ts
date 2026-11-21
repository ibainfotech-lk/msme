import { z } from "zod";
import { checkoutIdempotencyKeySchema } from "../checkout/checkout.schema";

// Email is required for new registration but is NOT verified identity.
// Phone OTP remains the authentication method.
export const registrationCheckoutEmailSchema = z.string()
  .trim()
  .max(191)
  .email()
  .transform(value => value.toLowerCase());

export const registrationCheckoutBodySchema = z.object({
  full_name: z.string().trim().min(1).max(150),
  email: registrationCheckoutEmailSchema,
  business_name: z.string().trim().min(1).max(150),
  business_type: z.enum([
    "sole_proprietor",
    "private_limited_company",
    "community_organization",
  ]),
  preferred_language: z.enum(["en", "ta", "si"]),
  plan_code: z.string().trim().min(1).max(50).regex(/^[A-Z0-9_]+$/),
}).strict();

export const registrationIdempotencyKeySchema =
  checkoutIdempotencyKeySchema.min(16);

export type RegistrationCheckoutBody = z.infer<
  typeof registrationCheckoutBodySchema
>;
