
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

// GET /api/business/mine
// Resolve memberships from the authenticated session only.
// PENDING businesses may access billing, not bookkeeping data.
router.get("/mine", requireAuth, async (req, res, next) => {
    const userId = req.session.userId;

    if (typeof userId !== "string") {
        res.status(401).json({
            success: false,
            code: "AUTH_REQUIRED"
        });
        return;
    }

    try {
        const pool = (await import("../config/database")).default;
        const [rows] = await pool.execute<
            import("mysql2/promise").RowDataPacket[]
        >(
            `SELECT b.id, b.name, b.status, b.current_subscription_id
             FROM business_memberships bm
             INNER JOIN businesses b ON b.id = bm.business_id
             INNER JOIN users u ON u.id = bm.user_id
             WHERE bm.user_id = ?
               AND bm.status = 'ACTIVE'
               AND u.status = 'ACTIVE'
             ORDER BY (b.status = 'ACTIVE') DESC, b.created_at DESC
             LIMIT 20`,
            [userId]
        );

        res.status(200).json({
            success: true,
            data: rows.map(row => ({
                id: row.id,
                name: row.name,
                status: row.status,
                current_subscription_id: row.current_subscription_id
            }))
        });
    } catch (error) {
        next(error);
    }
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
