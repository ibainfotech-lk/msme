import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { requireCheckoutOrigin } from "../../middleware/checkout-origin.middleware";
import { requireBusinessAccess } from "../../middleware/business-access.middleware";
import { requirePermission } from "../../middleware/permission.middleware";

import {
    createCheckoutOrderController
} from "./checkout.controller";

const router = Router();

// POST /api/checkout/business/:businessId/orders
router.post(
    "/business/:businessId/orders",
    requireCheckoutOrigin,
    requireAuth,
    requireBusinessAccess,
    requirePermission("billing.manage"),
    createCheckoutOrderController
);

export default router;