import { Router } from "express";
import { getSubscriptionPlans, getCurrentBusinessSubscription } from "./subscription.controller";

import { requireAuth } from "../../middleware/auth.middleware";
import { requireBusinessAccess } from "../../middleware/business-access.middleware";
import { requirePermission } from "../../middleware/permission.middleware";

const router = Router();

// GET /api/subscriptions/plans
// Public, read-only plan catalogue.
router.get("/plans", getSubscriptionPlans);


// GET /api/subscriptions/business/:businessId/current
router.get(
    "/business/:businessId/current",
    requireAuth,
    requireBusinessAccess,
    requirePermission("business.read"),
    getCurrentBusinessSubscription
);

export default router;