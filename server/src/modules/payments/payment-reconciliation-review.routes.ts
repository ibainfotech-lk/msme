import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { requireBusinessAccess } from "../../middleware/business-access.middleware";
import { requirePermission } from "../../middleware/permission.middleware";

import {
    getPaymentReconciliationReviewController,
} from "./payment-reconciliation-review.controller";

const router = Router();

// Development-only, explicitly opted-in review endpoint.
//
// This file is intentionally NOT mounted in index.ts.
//
// Even if mounted later, no route is registered unless
// both conditions below are satisfied.
//
// Reconciliation evidence is informational and UNVERIFIED.
// This route must never confirm payments or activate subscriptions.
if (
    process.env.NODE_ENV === "development" &&
    process.env.NOTETO_ENABLE_RECONCILIATION_REVIEW === "true"
) {
    router.get(
        "/business/:businessId/payments/:paymentId/reconciliation-review",
        requireAuth,
        requireBusinessAccess,
        requirePermission("billing.manage"),
        getPaymentReconciliationReviewController
    );
}

export default router;