
import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { requireBusinessAccess } from "../middleware/business-access.middleware";
import { requirePermission } from "../middleware/permission.middleware";


const router = Router();

// GET /api/business
// Existing authentication smoke-test endpoint.
router.get("/", requireAuth, (req, res) => {
    return res.json({
        success: true,
        message: "Authenticated business API is working.",
        userId: req.session.userId
    });
});

// GET /api/business/:businessId
// Requires authenticated membership and business.read permission.
router.get(
    "/:businessId",
    requireAuth,
    requireBusinessAccess,
    requirePermission("business.read"),
    (req, res) => {
        const access = res.locals.businessAccess as {
            businessId: string;
            userId: string;
            roleName: string;
            businessStatus: string;
        };

        return res.status(200).json({
            success: true,
            message: "Business permission verified.",
            business: {
                id: access.businessId,
                status: access.businessStatus
            },
            membership: {
                user_id: access.userId,
                role: access.roleName,
                status: "ACTIVE"
            },
            authorization: {
                permission: "business.read",
                granted: true
            }
        });
    }
);





export default router;
