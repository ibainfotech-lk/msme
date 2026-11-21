import type { RequestHandler } from "express";

import {
    validateCreateCheckoutOrderInput
} from "./checkout.schema";

import {
    createCheckoutOrder,
    CheckoutError
} from "./checkout.service";

export const createCheckoutOrderController: RequestHandler =
    async (req, res, next) => {
        try {
            const access = res.locals.businessAccess as
                | {
                    businessId: string;
                    userId: string;
                }
                | undefined;

            if (
                !access ||
                access.businessId !== req.params.businessId ||
                access.userId !== req.session.userId
            ) {
                res.status(403).json({
                    success: false,
                    code: "BUSINESS_CONTEXT_MISMATCH",
                    message: "Invalid business authorization context."
                });
                return;
            }

            const validated =
                validateCreateCheckoutOrderInput(
                    req.body,
                    req.get("Idempotency-Key")
                );

            if (!validated.success) {
                res.status(400).json({
                    success: false,
                    code: validated.code,
                    message: validated.message
                });
                return;
            }

            const result = await createCheckoutOrder({
                businessId: access.businessId,
                userId: access.userId,
                planCode: validated.data.planCode,
                idempotencyKey: validated.data.idempotencyKey
            });

            const order = result.order;

            res.status(result.replayed ? 200 : 201).json({
                success: true,
                replayed: result.replayed,
                data: {
                    id: order.id,
                    business_id: order.business_id,
                    plan_code: order.plan_code,
                    status: order.status,
                    amount_lkr: order.amount_lkr,
                    expires_at: order.expires_at,
                    created_at: order.created_at
                }
            });
        } catch (error) {
            if (error instanceof CheckoutError) {
                res.status(error.statusCode).json({
                    success: false,
                    code: error.code,
                    message: error.message
                });
                return;
            }

            next(error);
        }
    };