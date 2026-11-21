import { randomUUID } from "node:crypto";
import type { RowDataPacket, PoolConnection } from "mysql2/promise";

import {
    getCheckoutConnection,
    findCheckoutPlan,
    findCheckoutBusinessForUpdate,
    findCheckoutOrderByKey,
    findCheckoutOrderById,
    insertCheckoutOrder,
    type CheckoutOrderRow
} from "./checkout.repository";

export class CheckoutError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "CheckoutError";
    }
}

// A trial reservation cancels the unpaid registration checkout. Do not allow
// a new checkout to bypass that cancellation while activation is pending.
async function rejectReservedTrial(connection: PoolConnection, businessId: string): Promise<void> {
    if (process.env.NOTETO_TRIAL_RESERVATIONS_ENABLED !== "true") return;
    const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM introductory_trial_grants WHERE business_id = ? AND status = 'RESERVED' LIMIT 1",
        [businessId]
    );
    if (rows.length !== 0) {
        throw new CheckoutError(409, "TRIAL_RESERVATION_PENDING", "Complete trial verification before starting a new checkout.");
    }
}

export interface CreateCheckoutOrderInput {
    businessId: string;
    userId: string;
    planCode: string;
    idempotencyKey: string;
}

export interface CreateCheckoutOrderResult {
    order: CheckoutOrderRow;
    replayed: boolean;
}

interface AuthorizationRow extends RowDataPacket {
    authorized: number;
}

function isDuplicateKeyError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
    );
}

function validateExistingOrder(
    order: CheckoutOrderRow,
    input: CreateCheckoutOrderInput
): CreateCheckoutOrderResult {
    if (
        order.business_id !== input.businessId ||
        order.plan_code !== input.planCode
    ) {
        throw new CheckoutError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key cannot be reused for this request."
        );
    }

    return {
        order,
        replayed: true
    };
}

async function recoverDuplicateOrder(
    input: CreateCheckoutOrderInput
): Promise<CreateCheckoutOrderResult> {
    const connection = await getCheckoutConnection();
    let transactionStarted = false;

    try {
        await connection.beginTransaction();
        transactionStarted = true;

        const business = await findCheckoutBusinessForUpdate(
            connection,
            input.businessId
        );

        if (
            !business ||
            (business.status !== "PENDING" &&
             business.status !== "ACTIVE")
        ) {
            throw new CheckoutError(
                403,
                "BUSINESS_ACCESS_DENIED",
                "Business access is not permitted."
            );
        }

        await rejectReservedTrial(connection, input.businessId);

        const [rows] = await connection.execute<AuthorizationRow[]>(
            `SELECT 1 AS authorized
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
             WHERE bm.business_id = ?
               AND bm.user_id = ?
               AND bm.status = 'ACTIVE'
               AND u.status = 'ACTIVE'
               AND p.\`key\` = 'billing.manage'
             LIMIT 1`,
            [input.businessId, input.userId]
        );

        if (rows.length === 0) {
            throw new CheckoutError(
                403,
                "BILLING_PERMISSION_DENIED",
                "Billing permission is required."
            );
        }

        const existing = await findCheckoutOrderByKey(
            connection,
            input.idempotencyKey
        );

        if (!existing) {
            throw new CheckoutError(
                409,
                "CHECKOUT_CONFLICT",
                "The checkout request conflicts with an existing record."
            );
        }

        const result = validateExistingOrder(existing, input);

        await connection.commit();
        transactionStarted = false;

        return result;
    } catch (error) {
        if (transactionStarted) {
            await connection.rollback();
        }

        throw error;
    } finally {
        connection.release();
    }
}
export async function createCheckoutOrder(
    input: CreateCheckoutOrderInput
): Promise<CreateCheckoutOrderResult> {
    const connection = await getCheckoutConnection();
    let transactionStarted = false;
    let duplicateKey = false;

    try {
        await connection.beginTransaction();
        transactionStarted = true;

        // Serialize checkout creation for this business.
        const business = await findCheckoutBusinessForUpdate(
            connection,
            input.businessId
        );

        if (!business) {
            throw new CheckoutError(
                403,
                "BUSINESS_ACCESS_DENIED",
                "Business access is not permitted."
            );
        }

        if (
            business.status !== "PENDING" &&
            business.status !== "ACTIVE"
        ) {
            throw new CheckoutError(
                403,
                "BUSINESS_CHECKOUT_DISABLED",
                "Checkout is unavailable for this business."
            );
        }

        await rejectReservedTrial(connection, input.businessId);

        // Recheck authorization within the transaction.
        const [authorizationRows] =
            await connection.execute<AuthorizationRow[]>(
                `SELECT 1 AS authorized
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
                 WHERE bm.business_id = ?
                   AND bm.user_id = ?
                   AND bm.status = 'ACTIVE'
                   AND u.status = 'ACTIVE'
                   AND p.\`key\` = 'billing.manage'
                 LIMIT 1`,
                [input.businessId, input.userId]
            );

        if (authorizationRows.length === 0) {
            throw new CheckoutError(
                403,
                "BILLING_PERMISSION_DENIED",
                "Billing permission is required."
            );
        }

        // Look for an existing order before creating a new one.
        const existing = await findCheckoutOrderByKey(
            connection,
            input.idempotencyKey
        );

        if (existing) {
            const result = validateExistingOrder(
                existing,
                input
            );

            await connection.commit();
            transactionStarted = false;

            return result;
        }

        const plan = await findCheckoutPlan(
            connection,
            input.planCode
        );

        if (!plan || Number(plan.is_active) !== 1) {
            throw new CheckoutError(
                400,
                "INVALID_SUBSCRIPTION_PLAN",
                "The selected subscription plan is unavailable."
            );
        }

        // A checkout order expires after 30 minutes.
        const expiresAt = new Date(
            Date.now() + 30 * 60 * 1000
        );

        const orderId = randomUUID();

        await insertCheckoutOrder(connection, {
            id: orderId,
            businessId: input.businessId,
            planId: plan.id,
            amountLkr: plan.price_lkr,
            idempotencyKey: input.idempotencyKey,
            expiresAt
        });

        const created = await findCheckoutOrderById(
            connection,
            orderId,
            input.businessId
        );

        if (!created) {
            throw new Error(
                "Checkout order could not be retrieved."
            );
        }

        await connection.commit();
        transactionStarted = false;

        return {
            order: created,
            replayed: false
        };
    } catch (error) {
        duplicateKey = isDuplicateKeyError(error);

        if (transactionStarted) {
            await connection.rollback();
            transactionStarted = false;
        }

        if (!duplicateKey) {
            throw error;
        }
    } finally {
        connection.release();
    }

    // The unique index is the final concurrency safeguard.
    // Recover only after releasing the failed transaction.
    return recoverDuplicateOrder(input);
}