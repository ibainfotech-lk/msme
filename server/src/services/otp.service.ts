
import { randomInt, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "mysql2";
import pool from "../config/database";

const OTP_EXPIRY_MINUTES = 5;
const MAX_OTP_ATTEMPTS = 5;
const DUMMY_OTP_HASH =
    "$2b$10$C6UzMDM.H6dfI/f/IKcEeOeN6Kn8G1W5Yp5jN9z1Yc9JjG9tZtVvO";

interface OtpRow extends RowDataPacket {
    id: string;
    otp_hash: string;
    attempts: number;
    not_expired: number;
}

export type OtpVerificationResult =
    | { success: true }
    | {
          success: false;
          reason: "INVALID" | "EXPIRED" | "TOO_MANY_ATTEMPTS";
      };

export async function createOtpChallenge(
    phone: string
): Promise<string> {
    const otp = String(randomInt(100000, 1000000));
    const otpHash = await bcrypt.hash(otp, 12);
    const id = randomUUID();

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        await connection.execute(
            `DELETE FROM otp_verifications
             WHERE phone = ?`,
            [phone]
        );

        await connection.execute(
            `INSERT INTO otp_verifications
                (id, phone, otp_hash, attempts, expires_at)
             VALUES (
                ?, ?, ?, 0,
                DATE_ADD(
                    UTC_TIMESTAMP(3),
                    INTERVAL ? MINUTE
                )
             )`,
            [id, phone, otpHash, OTP_EXPIRY_MINUTES]
        );

        await connection.commit();

        // This value must be sent only through an approved OTP
        // delivery mechanism. Never return it to the client.
        return otp;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

export async function verifyOtpChallenge(
    phone: string,
    otp: string
): Promise<OtpVerificationResult> {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute<OtpRow[]>(
            `SELECT
                id,
                otp_hash,
                attempts,
                (expires_at > UTC_TIMESTAMP(3)) AS not_expired
             FROM otp_verifications
             WHERE phone = ?
             LIMIT 1
             FOR UPDATE`,
            [phone]
        );

        const record = rows[0];

        if (!record) {
            await connection.commit();

            // Perform a comparison even when the record is absent
            // to reduce timing differences.
            await bcrypt.compare(otp, DUMMY_OTP_HASH);

            return {
                success: false,
                reason: "INVALID"
            };
        }

        if (record.attempts >= MAX_OTP_ATTEMPTS) {
            await connection.commit();

            return {
                success: false,
                reason: "TOO_MANY_ATTEMPTS"
            };
        }

        if (!record.not_expired) {
            await connection.execute(
                `DELETE FROM otp_verifications
                 WHERE id = ?`,
                [record.id]
            );

            await connection.commit();

            return {
                success: false,
                reason: "EXPIRED"
            };
        }

        const matches = await bcrypt.compare(
            otp,
            record.otp_hash
        );

        if (!matches) {
            await connection.execute(
                `UPDATE otp_verifications
                 SET attempts = attempts + 1
                 WHERE id = ?`,
                [record.id]
            );

            await connection.commit();

            return {
                success: false,
                reason:
                    record.attempts + 1 >= MAX_OTP_ATTEMPTS
                        ? "TOO_MANY_ATTEMPTS"
                        : "INVALID"
            };
        }

        // Delete the challenge inside the same transaction.
        // A successful OTP cannot be used again.
        await connection.execute(
            `DELETE FROM otp_verifications
             WHERE id = ?`,
            [record.id]
        );

        await connection.commit();

        return { success: true };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}
