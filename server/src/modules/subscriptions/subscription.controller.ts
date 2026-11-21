import type { RequestHandler } from "express";
import { findActiveSubscriptionPlans, findCurrentBusinessSubscription } from "./subscription.repository";

export const getSubscriptionPlans: RequestHandler =
    async (_req, res, next) => {
        try {
            const plans = await findActiveSubscriptionPlans();

            res.status(200).json({
                success: true,
                data: plans.map((plan) => ({
                    id: plan.id,
                    code: plan.code,
                    name: plan.name,
                    price_lkr: plan.price_lkr,
                    billing_interval: plan.billing_interval,
                    invoice_limit: plan.invoice_limit,
                    trial_days: plan.trial_days
                }))
            });
        } catch (error) {
            next(error);
        }
    };
export const getCurrentBusinessSubscription: RequestHandler =
    async (req, res, next) => {
        try {
            const access = res.locals.businessAccess as
                | { businessId: string; userId: string }
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

            const subscription =
                await findCurrentBusinessSubscription(access.businessId);

            res.status(200).json({
                success: true,
                data: {
                    business_id: access.businessId,
                    subscription
                }
            });
        } catch (error) {
            next(error);
        }
    };