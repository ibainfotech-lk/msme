
import { Router } from "express";
import type { RowDataPacket } from "mysql2";
import pool from "../config/database";

import {
    createOtpChallenge,
    verifyOtpChallenge,
} from "../services/otp.service";

import type { PreferredLanguage } from "../services/registration.service";
import { requireCheckoutOrigin } from "../middleware/checkout-origin.middleware";
import { registerCheckoutController } from "../modules/checkout/registration-checkout.controller";

const router = Router();

const isValidPhone = (phone: string): boolean =>
    /^\+[1-9]\d{7,14}$/.test(phone);

interface UserRow extends RowDataPacket {
    id: string;
    full_name: string | null;
    phone: string;
    preferred_language: PreferredLanguage;
    status: string;
}

function readPhone(body: unknown): string {
    if (!body || typeof body !== "object") return "";

    const value = (body as Record<string, unknown>)
        .phone_number;

    return typeof value === "string"
        ? value.trim()
        : "";
}

function regenerateSession(
    req: import("express").Request
): Promise<void> {
    return new Promise((resolve, reject) => {
        req.session.regenerate((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function saveSession(
    req: import("express").Request
): Promise<void> {
    return new Promise((resolve, reject) => {
        req.session.save((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

// POST /api/auth/request-otp
router.post("/request-otp", async (req, res) => {
    const phone = readPhone(req.body);

    if (!isValidPhone(phone)) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid international mobile number.",
        });
    }

    // SMS delivery and distributed request throttling
    // are not configured yet. Never issue production OTPs
    // without those protections.
    if (process.env.NODE_ENV === "production") {
        return res.status(503).json({
            success: false,
            code: "OTP_DELIVERY_NOT_CONFIGURED",
            message: "OTP delivery is temporarily unavailable.",
        });
    }

    // Local development only. Do not expose this route
    // on a public or shared development server.
    try {
        const otp = await createOtpChallenge(phone);

        console.log(`[LOCAL DEVELOPMENT OTP] ${phone}: ${otp}`);

        return res.json({
            success: true,
            message: "OTP generated. Check the local backend terminal.",
        });
    } catch (error) {
        console.error("[OTP] Request failed:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to generate OTP.",
        });
    }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", async (req, res) => {
    const phone = readPhone(req.body);

    const otp =
        typeof req.body?.otp === "string"
            ? req.body.otp.trim()
            : "";

    if (!isValidPhone(phone) || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid mobile number and six-digit OTP.",
        });
    }

    if (process.env.NODE_ENV === "production") {
        return res.status(503).json({
            success: false,
            code: "OTP_DELIVERY_NOT_CONFIGURED",
            message: "OTP verification is temporarily unavailable.",
        });
    }

    try {
        const result = await verifyOtpChallenge(phone, otp);

        if (!result.success) {
            return res.status(
                result.reason === "TOO_MANY_ATTEMPTS" ? 429 : 400
            ).json({
                success: false,
                message:
                    result.reason === "TOO_MANY_ATTEMPTS"
                        ? "Too many attempts. Request a new OTP."
                        : "Invalid or expired OTP.",
            });
        }

        const [rows] = await pool.execute<UserRow[]>(
            `SELECT
                id,
                full_name,
                phone,
                preferred_language,
                status
             FROM users
             WHERE phone = ?
             LIMIT 1`,
            [phone]
        );

        const user = rows[0];

        await regenerateSession(req);

        if (user) {
            if (user.status !== "ACTIVE") {
                return res.status(403).json({
                    success: false,
                    message: "This account is not active.",
                });
            }

            req.session.userId = user.id;
            await saveSession(req);

            return res.json({
                success: true,
                message: "Login successful.",
                registration_required: false,
                user: {
                    id: user.id,
                    full_name: user.full_name,
                    phone_number: user.phone,
                    preferred_language: user.preferred_language,
                },
            });
        }

        req.session.verifiedPhone = phone;
        req.session.verifiedPhoneAt = Date.now();
        await saveSession(req);

        return res.json({
            success: true,
            message: "Mobile number verified.",
            registration_required: true,
        });
    } catch (error) {
        console.error("[OTP] Verification failed:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to verify OTP.",
        });
    }
});

// Development-only verified OTP → pending owner/business → atomic checkout.
// Origin check is required because this route consumes a session cookie.
router.post(
    "/register-checkout",
    requireCheckoutOrigin,
    registerCheckoutController
);

// Legacy registration without a selected plan has been retired.
// No alternative may bypass the payment-first checkout journey.
router.post("/register", (_req, res) => {
    res.status(410).json({
        success: false,
        code: "PAYMENT_FIRST_REGISTRATION_REQUIRED",
        message: "Select a plan and use verified-OTP registration checkout."
    });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).json({
                success: false,
                message: "Unable to log out.",
            });
        }

        res.clearCookie("noteto.sid");

        return res.json({
            success: true,
            message: "Logged out successfully.",
        });
    });
});

// Development bypasses are deliberately disabled.
// Use the local OTP flow instead.
router.post(
    ["/dev-login", "/dev-continue-registration"],
    (_req, res) => {
        return res.status(403).json({
            success: false,
            code: "DEV_AUTH_BYPASS_DISABLED",
            message: "Development authentication bypass is disabled.",
        });
    }
);

export default router;
