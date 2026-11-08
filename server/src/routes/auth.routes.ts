
import { Router } from "express";
import bcrypt from "bcryptjs";
import pool from "../config/database";


const router = Router();

const isValidPhone = (phone: string): boolean =>
    /^\+[1-9]\d{7,14}$/.test(phone);

// POST /api/auth/request-otp
router.post("/request-otp", async (req, res) => {
    console.log("[DEBUG] request-otp route reached");
    console.log("[DEBUG] Request body:", req.body);
    const phone =
        typeof req.body?.phone_number === "string"
            ? req.body.phone_number.trim()
            : "";

    console.log("[OTP] Request received for:", phone || "(empty number)");

    if (!isValidPhone(phone)) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid international mobile number, e.g. +94771234567."
        });
    }

    try {
        const otp = String(
            Math.floor(100000 + Math.random() * 900000)
        );

        console.log("[DEBUG] OTP generated for:", phone);
        console.log("[DEBUG] NODE_ENV:", process.env.NODE_ENV);

        const otpHash = await bcrypt.hash(otp, 10);

        await pool.execute(
            "DELETE FROM otp_verifications WHERE phone_number = ?",
            [phone]
        );

        await pool.execute(
            `INSERT INTO otp_verifications
            (phone_number, otp_hash, expires_at, attempts)
         VALUES (
            ?, ?,
            DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE),
            0
         )`,
            [phone, otpHash]
        );

        console.log("[DEBUG] OTP saved to database");

        if (process.env.NODE_ENV !== "production") {
            console.log(`[DEVELOPMENT OTP] ${phone}: ${otp}`);
        }

        return res.json({
            success: true,
            message:
                process.env.NODE_ENV === "production"
                    ? "If the number can receive a code, follow the SMS instructions."
                    : "OTP generated. Check the backend terminal."
        });
    } catch (error) {
        console.error("[OTP] Request failed:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to generate OTP. Check the backend terminal."
        });
    }
});

// POST /api/auth/verify-otp
router.post("/verify-otp", async (req, res) => {
    const phone =
        typeof req.body?.phone_number === "string"
            ? req.body.phone_number.trim()
            : "";

    const otp =
        typeof req.body?.otp === "string"
            ? req.body.otp.trim()
            : "";

    if (!isValidPhone(phone) || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid mobile number and six-digit OTP."
        });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT id, otp_hash, attempts,
                    (expires_at > UTC_TIMESTAMP()) AS not_expired
             FROM otp_verifications
             WHERE phone_number = ?
             ORDER BY id DESC
             LIMIT 1`,
            [phone]
        );

        const records = rows as Array<{
            id: number;
            otp_hash: string;
            attempts: number;
            not_expired: number;
        }>;

        if (records.length === 0) {
            return res.status(400).json({
                success: false,
                message: "OTP not found. Request a new code."
            });
        }

        const record = records[0];

        if (record.attempts >= 5) {
            return res.status(429).json({
                success: false,
                message: "Too many attempts. Request a new OTP."
            });
        }

        if (!record.not_expired) {
            await pool.execute(
                "DELETE FROM otp_verifications WHERE phone_number = ?",
                [phone]
            );

            return res.status(400).json({
                success: false,
                message: "OTP expired. Request a new code."
            });
        }

        const matches = await bcrypt.compare(otp, record.otp_hash);

        if (!matches) {
            await pool.execute(
                `UPDATE otp_verifications
                 SET attempts = attempts + 1
                 WHERE id = ?`,
                [record.id]
            );

            return res.status(400).json({
                success: false,
                message: "Incorrect OTP."
            });
        }

        // A valid OTP must never be reusable.
        await pool.execute(
            "DELETE FROM otp_verifications WHERE phone_number = ?",
            [phone]
        );

        const [userRows] = await pool.execute(
            `SELECT id, full_name, phone_number, preferred_language
             FROM users
             WHERE phone_number = ?
             LIMIT 1`,
            [phone]
        );

        const users = userRows as Array<{
            id: number;
            full_name: string;
            phone_number: string;
            preferred_language: "en" | "ta" | "si";
        }>;

        // Existing user: start a login session.
        if (users.length > 0) {
            const user = users[0];

            return req.session.regenerate((sessionError) => {
                if (sessionError) {
                    console.error("[OTP] Session regeneration failed:", sessionError);

                    return res.status(500).json({
                        success: false,
                        message: "Unable to create login session."
                    });
                }

                req.session.userId = user.id;

                req.session.save((saveError) => {
                    if (saveError) {
                        console.error("[OTP] Session save failed:", saveError);

                        return res.status(500).json({
                            success: false,
                            message: "Unable to save login session."
                        });
                    }

                    return res.json({
                        success: true,
                        message: "Login successful.",
                        registration_required: false,
                        user: {
                            id: user.id,
                            full_name: user.full_name,
                            phone_number: user.phone_number,
                            preferred_language: user.preferred_language
                        }
                    });
                });
            });
        }

        // New user: require registration.
        return req.session.regenerate((sessionError) => {
            if (sessionError) {
                console.error("[OTP] Session regeneration failed:", sessionError);

                return res.status(500).json({
                    success: false,
                    message: "Unable to start registration."
                });
            }

            req.session.verifiedPhone = phone;

            req.session.save((saveError) => {
                if (saveError) {
                    console.error("[OTP] Session save failed:", saveError);

                    return res.status(500).json({
                        success: false,
                        message: "Unable to save phone verification."
                    });
                }

                return res.json({
                    success: true,
                    message: "Mobile number verified.",
                    registration_required: true
                });
            });
        });
    } catch (error) {
        console.error("[OTP] Verification failed:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to verify OTP. Check the backend terminal."
        });
    }
});







/**
 * DEVELOPMENT ONLY — create a user and business without OTP validation.
 * Do not enable this flow in production.
 */
router.post("/register", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
        return res.status(403).json({
            success: false,
            message: "Development registration is disabled."
        });
    }

    const phone = req.session.verifiedPhone;

    if (!phone || !isValidPhone(phone)) {
        return res.status(401).json({
            success: false,
            message: "Please enter your mobile number and continue again."
        });
    }

    const fullName =
        typeof req.body?.full_name === "string"
            ? req.body.full_name.trim()
            : "";

    const businessName =
        typeof req.body?.business_name === "string"
            ? req.body.business_name.trim()
            : "";

    const businessType = req.body?.business_type;
    const language = req.body?.preferred_language;

    const allowedBusinessTypes = [
        "sole_proprietor",
        "private_limited_company",
        "community_organization"
    ];

    const allowedLanguages = ["en", "ta", "si"];

    if (
        !fullName ||
        fullName.length > 150 ||
        !businessName ||
        businessName.length > 150 ||
        !allowedBusinessTypes.includes(businessType) ||
        !allowedLanguages.includes(language)
    ) {
        return res.status(400).json({
            success: false,
            message: "Please complete all required fields."
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [existingRows] = await connection.execute(
            "SELECT id FROM users WHERE phone_number = ? LIMIT 1",
            [phone]
        );

        if ((existingRows as Array<{ id: number }>).length > 0) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "This mobile number already has an account."
            });
        }

        const [userResult] = await connection.execute(
            `INSERT INTO users
                (full_name, phone_number, email, password_hash, preferred_language)
             VALUES (?, ?, NULL, NULL, ?)`,
            [fullName, phone, language]
        );

        const userId = (userResult as { insertId: number }).insertId;

        const [businessResult] = await connection.execute(
            `INSERT INTO businesses
                (business_name, business_type, preferred_language)
             VALUES (?, ?, ?)`,
            [businessName, businessType, language]
        );

        const businessId =
            (businessResult as { insertId: number }).insertId;

        await connection.execute(
            `INSERT INTO business_memberships
                (user_id, business_id, role)
             VALUES (?, ?, ?)`,
            [userId, businessId, "owner"]
        );

        await connection.commit();

        req.session.userId = userId;
        req.session.verifiedPhone = undefined;

        req.session.save((error) => {
            if (error) {
                console.error("[REGISTER] Session save failed:", error);
                return res.status(500).json({
                    success: false,
                    message: "Account created, but login session could not be saved."
                });
            }

            return res.status(201).json({
                success: true,
                message: "Account created successfully.",
                user: {
                    id: userId,
                    full_name: fullName,
                    phone_number: phone,
                    preferred_language: language
                },
                business: {
                    id: businessId,
                    business_name: businessName,
                    business_type: businessType
                }
            });
        });
    } catch (error) {
        await connection.rollback();
        console.error("[REGISTER] Registration failed:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to create account. Check the backend terminal."
        });
    } finally {
        connection.release();
    }
});





//without OTP

router.post("/dev-continue-registration", (req, res) => {
    if (process.env.NODE_ENV === "production") {
        return res.status(403).json({
            success: false,
            message: "Development route disabled."
        });
    }

    const phone =
        typeof req.body?.phone_number === "string"
            ? req.body.phone_number.trim()
            : "";

    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid international mobile number."
        });
    }

    req.session.verifiedPhone = phone;

    req.session.save((error) => {
        if (error) {
            console.error("[DEV] Session save failed:", error);
            return res.status(500).json({
                success: false,
                message: "Could not save session."
            });
        }

        return res.json({
            success: true,
            message: "Development mode: continuing without OTP.",
            registration_required: true
        });
    });
});

//end



router.post("/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error("[LOGOUT] Failed:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to log out. Please try again."
            });
        }

        res.clearCookie("noteto.sid");

        return res.json({
            success: true,
            message: "Logged out successfully."
        });
    });
});



router.post("/dev-login", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
        return res.status(403).json({
            success: false,
            message: "Development login is disabled."
        });
    }

    const phone =
        typeof req.body?.phone_number === "string"
            ? req.body.phone_number.trim()
            : "";

    if (!isValidPhone(phone)) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid international mobile number."
        });
    }

    try {
        const [rows] = await pool.execute(
            `SELECT id, full_name, phone_number, preferred_language
             FROM users
             WHERE phone_number = ?
             LIMIT 1`,
            [phone]
        );

        const users = rows as Array<{
            id: number;
            full_name: string;
            phone_number: string;
            preferred_language: "en" | "ta" | "si";
        }>;

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No account found. Continue to registration."
            });
        }

        const user = users[0];

        req.session.regenerate((sessionError) => {
            if (sessionError) {
                return res.status(500).json({
                    success: false,
                    message: "Unable to create login session."
                });
            }

            req.session.userId = user.id;

            req.session.save((saveError) => {
                if (saveError) {
                    return res.status(500).json({
                        success: false,
                        message: "Unable to save login session."
                    });
                }

                return res.json({
                    success: true,
                    message: "Development login successful.",
                    user
                });
            });
        });
    } catch (error) {
        console.error("[DEV LOGIN] Failed:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to log in. Check the backend terminal."
        });
    }
});




export default router;
