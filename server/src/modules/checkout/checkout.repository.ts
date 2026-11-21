import type {
    PoolConnection,
    RowDataPacket,
    ResultSetHeader
} from "mysql2/promise";

import pool from "../../config/database";

export interface CheckoutPlanRow extends RowDataPacket {
    id: string;
    code: string;
    name: string;
    price_lkr: string;
    is_active: number;
}

export interface CheckoutOrderRow extends RowDataPacket {
    id: string;
    business_id: string;
    plan_id: string;
    plan_code: string;
    status: string;
    amount_lkr: string;
    idempotency_key: string;
    expires_at: Date | null;
    created_at: Date;
}

export interface CheckoutBusinessRow extends RowDataPacket {
    id: string;
    status: string;
}

export async function getCheckoutConnection():
    Promise<PoolConnection> {
    return pool.getConnection();
}

export async function findCheckoutPlan(
    connection: PoolConnection,
    planCode: string
): Promise<CheckoutPlanRow | null> {
    const [rows] = await connection.execute<CheckoutPlanRow[]>(
        `SELECT
            id,
            code,
            name,
            price_lkr,
            is_active
         FROM subscription_plans
         WHERE code = ?
         LIMIT 1`,
        [planCode]
    );

    return rows[0] ?? null;
}

export async function findCheckoutBusinessForUpdate(
    connection: PoolConnection,
    businessId: string
): Promise<CheckoutBusinessRow | null> {
    const [rows] = await connection.execute<CheckoutBusinessRow[]>(
        `SELECT id, status
         FROM businesses
         WHERE id = ?
         FOR UPDATE`,
        [businessId]
    );

    return rows[0] ?? null;
}

export async function findCheckoutOrderByKey(
    connection: PoolConnection,
    idempotencyKey: string
): Promise<CheckoutOrderRow | null> {
    const [rows] = await connection.execute<CheckoutOrderRow[]>(
        `SELECT
            co.id,
            co.business_id,
            co.plan_id,
            sp.code AS plan_code,
            co.status,
            co.amount_lkr,
            co.idempotency_key,
            co.expires_at,
            co.created_at
         FROM checkout_orders co
         INNER JOIN subscription_plans sp
             ON sp.id = co.plan_id
         WHERE co.idempotency_key = ?
         LIMIT 1`,
        [idempotencyKey]
    );

    return rows[0] ?? null;
}

export interface InsertCheckoutOrderInput {
    id: string;
    businessId: string;
    planId: string;
    amountLkr: string;
    idempotencyKey: string;
    expiresAt: Date;
}

export async function insertCheckoutOrder(
    connection: PoolConnection,
    input: InsertCheckoutOrderInput
): Promise<void> {
    await connection.execute<ResultSetHeader>(
        `INSERT INTO checkout_orders (
            id,
            business_id,
            plan_id,
            status,
            amount_lkr,
            idempotency_key,
            expires_at,
            created_at,
            updated_at
        ) VALUES (
            ?, ?, ?, 'PENDING', ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
        )`,
        [
            input.id,
            input.businessId,
            input.planId,
            input.amountLkr,
            input.idempotencyKey,
            input.expiresAt
        ]
    );
}

export async function findCheckoutOrderById(
    connection: PoolConnection,
    orderId: string,
    businessId: string
): Promise<CheckoutOrderRow | null> {
    const [rows] = await connection.execute<CheckoutOrderRow[]>(
        `SELECT
            co.id,
            co.business_id,
            co.plan_id,
            sp.code AS plan_code,
            co.status,
            co.amount_lkr,
            co.idempotency_key,
            co.expires_at,
            co.created_at
         FROM checkout_orders co
         INNER JOIN subscription_plans sp
             ON sp.id = co.plan_id
         WHERE co.id = ?
           AND co.business_id = ?
         LIMIT 1`,
        [orderId, businessId]
    );

    return rows[0] ?? null;
}