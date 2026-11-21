
import type { RequestHandler } from "express";
import type { RowDataPacket } from "mysql2";
import pool from "../config/database";

interface PermissionRow extends RowDataPacket {
    permission_key: string;
}

interface BusinessAccess {
    businessId: string;
    userId: string;
    roleName: string;
    businessStatus: string;
}

export function requirePermission(
    permissionKey: string
): RequestHandler {
    return async (req, res, next) => {
        const access = res.locals.businessAccess as
            | BusinessAccess
            | undefined;

        if (
            !access ||
            !access.businessId ||
            !access.userId
        ) {
            res.status(403).json({
                success: false,
                code: "BUSINESS_ACCESS_REQUIRED",
                message: "Business authorization is required."
            });
            return;
        }

        // Fail closed: do not accept business access context
        // that conflicts with the authenticated session or URL.
        if (
            req.session.userId !== access.userId ||
            req.params.businessId !== access.businessId
        ) {
            res.status(403).json({
                success: false,
                code: "BUSINESS_CONTEXT_MISMATCH",
                message: "Invalid business authorization context."
            });
            return;
        }

        try {
            // Recheck current membership and permission
            // against the database for this request.
            const [rows] = await pool.execute<PermissionRow[]>(
                `SELECT p.\`key\` AS permission_key
                 FROM business_memberships bm
                 INNER JOIN users u
                    ON u.id = bm.user_id
                 INNER JOIN roles r
                    ON r.id = bm.role_id
                    AND r.business_id = bm.business_id
                 INNER JOIN role_permissions rp
                    ON rp.role_id = r.id
                 INNER JOIN permissions p
                    ON p.id = rp.permission_id
                 WHERE bm.user_id = ?
                   AND bm.business_id = ?
                   AND bm.status = 'ACTIVE'
                   AND u.status = 'ACTIVE'
                   AND p.\`key\` = ?
                 LIMIT 1`,
                [
                    access.userId,
                    access.businessId,
                    permissionKey
                ]
            );

            if (rows.length === 0) {
                res.status(403).json({
                    success: false,
                    code: "PERMISSION_DENIED",
                    message: "You do not have permission for this action."
                });
                return;
            }

            next();
        } catch (error) {
            console.error(
                "[PERMISSION] Authorization query failed:",
                error
            );

            res.status(500).json({
                success: false,
                code: "PERMISSION_CHECK_ERROR",
                message: "Unable to verify permissions."
            });
        }
    };
}
