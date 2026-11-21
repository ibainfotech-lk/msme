import { z } from "zod";

export const createCheckoutOrderBodySchema = z
    .object({
        plan_code: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(
                /^[A-Z0-9_]+$/,
                "Invalid subscription plan code."
            )
    })
    .strict();

export const checkoutIdempotencyKeySchema = z
    .string()
    .min(1)
    .max(191)
    .regex(
        /^[A-Za-z0-9_-]+$/,
        "Invalid idempotency key."
    );

export type CreateCheckoutOrderBody = z.infer<
    typeof createCheckoutOrderBodySchema
>;

export function validateCreateCheckoutOrderInput(
    body: unknown,
    idempotencyKey: unknown
):
    | {
          success: true;
          data: {
              planCode: string;
              idempotencyKey: string;
          };
      }
    | {
          success: false;
          code: string;
          message: string;
      } {
    const parsedBody =
        createCheckoutOrderBodySchema.safeParse(body);

    if (!parsedBody.success) {
        return {
            success: false,
            code: "INVALID_CHECKOUT_REQUEST",
            message: "A valid plan_code is required."
        };
    }

    const parsedKey =
        checkoutIdempotencyKeySchema.safeParse(
            idempotencyKey
        );

    if (!parsedKey.success) {
        return {
            success: false,
            code: "INVALID_IDEMPOTENCY_KEY",
            message:
                "A valid Idempotency-Key header is required."
        };
    }

    return {
        success: true,
        data: {
            planCode: parsedBody.data.plan_code,
            idempotencyKey: parsedKey.data
        }
    };
}