
import { Router, Request, Response } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../config/database";
import { requireAuth } from "../middleware/auth.middleware";


const router = Router();

type TransactionType = "income" | "expense";

function isTransactionType(value: unknown): value is TransactionType {
    return value === "income" || value === "expense";
}



function parseAmount(value: unknown): string | null {
    if (
        typeof value !== "number" &&
        typeof value !== "string"
    ) {
        return null;
    }

    const amount = String(value).trim();

    // Allow up to 10 integer digits and 2 decimal places.
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount)) {
        return null;
    }

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        return null;
    }

    return amount;
}




interface MembershipRow extends RowDataPacket {
    business_id: number;
}

interface TransactionRow extends RowDataPacket {
    id: number;
    business_id: number;
    transaction_type: TransactionType;
    amount: string;
    category: string;
    description: string | null;
    transaction_date: string;
    created_at: string;
}

// Find a business the authenticated user belongs to.
async function getBusinessId(userId: number): Promise<number | null> {
    const [rows] = await pool.execute<MembershipRow[]>(
        `SELECT business_id
         FROM business_memberships
         WHERE user_id = ?
         ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, id ASC
         LIMIT 1`,
        [userId]
    );

    return rows.length ? Number(rows[0].business_id) : null;
}

// GET /api/transactions/summary
router.get("/summary", requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId;

        if (!userId) {
            res.status(401).json({ success: false, message: "Please log in." });
            return;
        }

        const businessId = await getBusinessId(userId);

        if (!businessId) {
            res.status(403).json({
                success: false,
                message: "No business is linked to this account."
            });
            return;
        }

        const [rows] = await pool.execute<RowDataPacket[]>(
            `SELECT
                COALESCE(SUM(CASE
                    WHEN transaction_type = 'income' THEN amount ELSE 0
                END), 0) AS todayIncome,
                COALESCE(SUM(CASE
                    WHEN transaction_type = 'expense' THEN amount ELSE 0
                END), 0) AS todayExpenses
             FROM cash_transactions
             WHERE business_id = ?
               AND transaction_date = CURDATE()`,
            [businessId]
        );

        const todayIncome = Number(rows[0].todayIncome);
        const todayExpenses = Number(rows[0].todayExpenses);

        res.json({
            success: true,
            summary: {
                todayIncome,
                todayExpenses,
                netBalance: todayIncome - todayExpenses
            }
        });
    } catch (error) {
        console.error("Transaction summary error:", error);
        res.status(500).json({
            success: false,
            message: "Could not load transaction summary."
        });
    }
});

// GET /api/transactions
router.get("/", requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId;

        if (!userId) {
            res.status(401).json({ success: false, message: "Please log in." });
            return;
        }

        const businessId = await getBusinessId(userId);

        if (!businessId) {
            res.status(403).json({
                success: false,
                message: "No business is linked to this account."
            });
            return;
        }


        const [rows] = await pool.execute<TransactionRow[]>(
            `SELECT
        id,
        business_id,
        transaction_type,
        amount,
        category,
        description,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
        created_at
     FROM cash_transactions
     WHERE business_id = ?
     ORDER BY transaction_date DESC, id DESC
     LIMIT 50`,
            [businessId]
        );


        res.json({ success: true, transactions: rows });
    } catch (error) {
        console.error("Get transactions error:", error);
        res.status(500).json({
            success: false,
            message: "Could not load transactions."
        });
    }
});

// POST /api/transactions
router.post("/", requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.session.userId;

        if (!userId) {
            res.status(401).json({ success: false, message: "Please log in." });
            return;
        }

        const businessId = await getBusinessId(userId);

        if (!businessId) {
            res.status(403).json({
                success: false,
                message: "No business is linked to this account."
            });
            return;
        }

        const {
            transaction_type,
            amount,
            category,
            description,
            transaction_date
        } = req.body;

        const validType = isTransactionType(transaction_type);

        const validAmount = parseAmount(amount);
        const validDate =
            typeof transaction_date === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(transaction_date) &&
            !Number.isNaN(Date.parse(`${transaction_date}T00:00:00Z`)) &&
            new Date(`${transaction_date}T00:00:00Z`).toISOString().slice(0, 10) === transaction_date;

        if (
            !validType ||
            !validAmount ||
            typeof category !== "string" ||
            !category.trim() ||
            category.trim().length > 100 ||
            !validDate ||
            (description != null &&
                (typeof description !== "string" || description.length > 255))
        ) {
            res.status(400).json({
                success: false,
                message: "Please provide a valid type, positive amount, category and date."
            });
            return;
        }



        const [result] = await pool.execute<ResultSetHeader>(
            `INSERT INTO cash_transactions
                (business_id, transaction_type, amount, category,
                 description, transaction_date, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                businessId,
                transaction_type,
                validAmount,
                category.trim(),
                description?.trim() || null,
                transaction_date,
                userId
            ]
        );

        res.status(201).json({
            success: true,
            message: transaction_type === "income"
                ? "Income saved successfully."
                : "Expense saved successfully.",
            transactionId: result.insertId
        });
    } catch (error) {
        console.error("Create transaction error:", error);
        res.status(500).json({
            success: false,
            message: "Could not save transaction."
        });
    }
});

export default router;
