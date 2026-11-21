
import { randomUUID } from "node:crypto";
import pool from "../config/database";

export type RegistrationType =
    | "SOLE_PROPRIETOR"
    | "PRIVATE_LIMITED"
    | "COMMUNITY_ORGANIZATION";

export type PreferredLanguage = "en" | "ta" | "si";

export interface RegistrationInput {
    phone: string;
    fullName: string;
    businessName: string;
    registrationType: RegistrationType;
    preferredLanguage: PreferredLanguage;
}

export class PhoneAlreadyRegisteredError extends Error {
    constructor() {
        super("This mobile number already has an account.");
        this.name = "PhoneAlreadyRegisteredError";
    }
}

export async function registerBusinessOwner(
    input: RegistrationInput
) {
    const connection = await pool.getConnection();

    const userId = randomUUID();
    const businessId = randomUUID();
    const roleId = randomUUID();
    const membershipId = randomUUID();

    let transactionStarted = false;

    try {
        await connection.beginTransaction();
        transactionStarted = true;

        const [existingRows] = await connection.execute(
            "SELECT id FROM users WHERE phone = ? LIMIT 1",
            [input.phone]
        );

        if (
            (existingRows as Array<{ id: string }>).length > 0
        ) {
            throw new PhoneAlreadyRegisteredError();
        }

        await connection.execute(
            `INSERT INTO users
                (
                    id,
                    phone,
                    full_name,
                    preferred_language,
                    phone_verified_at,
                    status,
                    updated_at
                )
             VALUES (
                    ?, ?, ?, ?, UTC_TIMESTAMP(3),
                    'ACTIVE', UTC_TIMESTAMP(3)
                )`,
            [
                userId,
                input.phone,
                input.fullName,
                input.preferredLanguage
            ]
        );

        await connection.execute(
            `INSERT INTO businesses
                (
                    id,
                    name,
                    registration_type,
                    status,
                    updated_at
                )
             VALUES (?, ?, ?, 'PENDING', UTC_TIMESTAMP(3))`,
            [
                businessId,
                input.businessName,
                input.registrationType
            ]
        );

        await connection.execute(
            `INSERT INTO roles
                (
                    id,
                    business_id,
                    name,
                    is_system_role,
                    updated_at
                )
             VALUES (?, ?, 'OWNER', 1, UTC_TIMESTAMP(3))`,
            [roleId, businessId]
        );


        // Assign all initial permissions to the new OWNER role.
        // This runs inside the existing registration transaction.
        const [permissionResult] = await connection.execute(
            `INSERT INTO role_permissions
                (role_id, permission_id)
             SELECT ?, p.id
             FROM permissions p`,
            [roleId]
        );

        const assignedPermissions =
            (permissionResult as { affectedRows: number }).affectedRows;

        // Fail registration rather than create an OWNER
        // with incomplete permission assignments.
        if (assignedPermissions !== 12) {
            throw new Error(
                `OWNER permission setup incomplete: expected 12, assigned ${assignedPermissions}`
            );
        }





        await connection.execute(
            `INSERT INTO business_memberships
                (
                    id,
                    business_id,
                    user_id,
                    role_id,
                    status,
                    updated_at
                )
             VALUES (
                    ?, ?, ?, ?, 'ACTIVE', UTC_TIMESTAMP(3)
                )`,
            [
                membershipId,
                businessId,
                userId,
                roleId
            ]
        );

        await connection.commit();
        transactionStarted = false;

        return {
            userId,
            businessId,
            roleId,
            membershipId
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    "[REGISTER] Transaction rollback failed:",
                    rollbackError
                );
            }
        }

        // Handle concurrent registrations for the same phone.
        if (
            error instanceof PhoneAlreadyRegisteredError ||
            (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ER_DUP_ENTRY"
            )
        ) {
            throw new PhoneAlreadyRegisteredError();
        }

        throw error;
    } finally {
        connection.release();
    }
}
