
import type { RequestHandler } from "express";
import type { RowDataPacket } from "mysql2";
import pool from "../config/database";

interface BusinessStatusRow extends RowDataPacket {
    status: "PENDING" | "ACTIVE" | "SUSPENDED" | "CLOSED";
}

export const requireActiveBusiness: RequestHandler =
    async (req, res, next) => {
        const userId = req.session?.userId;
        const businessId = req.params.businessId;

        const access = res.locals.businessAccess as
            | {
                userId: string;
                businessId: string;
            }
            | undefined;

        // Only run after authentication and business
        // membership authorization.
        if (
            !access ||
            typeof userId !== "string" ||
            typeof businessId !== "string" ||
            access.userId !== userId ||
            access.businessId !== businessId
        ) {
            res.status(403).json({
                success: false,
                code: "BUSINESS_ACCESS_REQUIRED",
                message: "Business authorization is required."
            });
            return;
        }

        try {
            // Recheck membership and business status from
            // the database rather than trusting cached state.
            const [rows] = await pool.execute<BusinessStatusRow[]>(
                `SELECT b.status
                 FROM businesses b
                 INNER JOIN business_memberships bm
                    ON bm.business_id = b.id
                 INNER JOIN users u
                    ON u.id = bm.user_id
                 WHERE b.id = ?
                   AND bm.user_id = ?
                   AND bm.status = 'ACTIVE'
                   AND u.status = 'ACTIVE'
                 LIMIT 1`,
                [businessId, userId]
            );

            if (rows.length === 0) {
                res.status(403).json({
                    success: false,
                    code: "BUSINESS_ACCESS_DENIED",
                    message: "Business access is not permitted."
                });
                return;
            }

            if (rows[0].status !== "ACTIVE") {
                res.status(403).json({
                    success: false,
                    code: "BUSINESS_NOT_ACTIVE",
                    message:
                        "Business activation is required to use this feature."
                });
                return;
            }

            next();
        } catch (error) {
            console.error(
                "[BUSINESS ACTIVATION] Verification failed:",
                error
            );

            res.status(500).json({
                success: false,
                code: "ACTIVATION_CHECK_ERROR",
                message: "Unable to verify business activation."
            });
        }
    };
