
import type { RequestHandler } from "express";
import type { RowDataPacket } from "mysql2";
import pool from "../config/database";

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface MembershipRow extends RowDataPacket {
    business_id: string;
    role_name: string;
    business_status: string;
}

export const requireBusinessAccess: RequestHandler =
    async (req, res, next) => {
        const userId = req.session.userId;

        if (
            typeof userId !== "string" ||
            !UUID_PATTERN.test(userId)
        ) {
            res.status(401).json({
                success: false,
                code: "AUTH_REQUIRED",
                message: "Authentication is required."
            });
            return;
        }

        // Business ID is explicitly supplied in the URL.
        // Never trust a business ID from the session alone.
        const businessId = req.params.businessId;

        if (
            typeof businessId !== "string" ||
            !UUID_PATTERN.test(businessId)
        ) {
            res.status(400).json({
                success: false,
                code: "INVALID_BUSINESS_ID",
                message: "A valid business ID is required."
            });
            return;
        }

        try {
            const [rows] = await pool.execute<MembershipRow[]>(
                `SELECT
                    bm.business_id,
                    r.name AS role_name,
                    b.status AS business_status
                 FROM business_memberships bm
                 INNER JOIN businesses b
                    ON b.id = bm.business_id
                 INNER JOIN roles r
                    ON r.id = bm.role_id
                    AND r.business_id = bm.business_id
                 INNER JOIN users u
                    ON u.id = bm.user_id
                 WHERE bm.business_id = ?
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
                    message: "You do not have access to this business."
                });
                return;
            }

            // Membership verified. Route handlers must still
            // enforce business status and action permissions.
            res.locals.businessAccess = {
                businessId: rows[0].business_id,
                userId,
                roleName: rows[0].role_name,
                businessStatus: rows[0].business_status
            };

            next();
        } catch (error) {
            console.error("[BUSINESS ACCESS] Failed:", error);

            res.status(500).json({
                success: false,
                code: "AUTHORIZATION_ERROR",
                message: "Unable to verify business access."
            });
        }
    };
