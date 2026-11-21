import type { RowDataPacket } from "mysql2";
import pool from "../../config/database";

export interface SubscriptionPlanRow extends RowDataPacket {
    id: string;
    code: string;
    name: string;
    price_lkr: string;
    billing_interval: "MONTHLY" | "YEARLY";
    invoice_limit: number;
    trial_days: number;
}

export async function findActiveSubscriptionPlans():
    Promise<SubscriptionPlanRow[]> {

    const [rows] = await pool.execute<SubscriptionPlanRow[]>(
        `SELECT
            id,
            code,
            name,
            price_lkr,
            billing_interval,
            invoice_limit,
            trial_days
         FROM subscription_plans
         WHERE is_active = 1
         ORDER BY price_lkr ASC, code ASC`
    );

    return rows;
}
export interface CurrentSubscriptionRow extends RowDataPacket {
    id: string;
    business_id: string;
    status: string;
    starts_at: Date | null;
    trial_ends_at: Date | null;
    current_period_start: Date | null;
    current_period_end: Date | null;
    plan_code: string;
    plan_name: string;
    price_lkr: string;
    invoice_limit: number;
}

export async function findCurrentBusinessSubscription(
    businessId: string
): Promise<CurrentSubscriptionRow | null> {
    const [rows] = await pool.execute<CurrentSubscriptionRow[]>(
        `SELECT
            bs.id,
            bs.business_id,
            bs.status,
            bs.starts_at,
            bs.trial_ends_at,
            bs.current_period_start,
            bs.current_period_end,
            sp.code AS plan_code,
            sp.name AS plan_name,
            sp.price_lkr,
            sp.invoice_limit
         FROM businesses b
         INNER JOIN business_subscriptions bs
            ON bs.id = b.current_subscription_id
            AND bs.business_id = b.id
         INNER JOIN subscription_plans sp
            ON sp.id = bs.plan_id
         WHERE b.id = ?
         LIMIT 1`,
        [businessId]
    );

    return rows[0] ?? null;
}