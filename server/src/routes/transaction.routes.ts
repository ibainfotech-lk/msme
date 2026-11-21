
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

/**
 * Noteto Package 1.0
 *
 * Transaction routes are temporarily unavailable until
 * the UUID-based cash transaction schema, business-scoped
 * authorization, and accounting rules are implemented.
 *
 * Do not restore the legacy numeric-ID SQL queries.
 */

router.use(requireAuth);

router.use((_req, res) => {
    return res.status(503).json({
        success: false,
        code: "FEATURE_NOT_READY",
        message:
            "Transaction services are not yet available."
    });
});

export default router;
