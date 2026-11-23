import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";
import mysql2 from "mysql2/promise";

import pool, {
    verifyDatabaseConnection,
} from "./config/database";
import authRoutes from "./routes/auth.routes";
import subscriptionRoutes from "./modules/subscriptions/subscription.routes";
import checkoutRoutes from "./modules/checkout/checkout.routes";
import businessRoutes from "./routes/business.routes";
import reconciliationReviewRoutes from "./modules/payments/payment-reconciliation-review.routes";
import { notFoundHandler, errorHandler } from "./middleware/error.middleware";
import transactionRoutes from "./routes/transaction.routes";
import invoiceRoutes from "./modules/invoices/invoice.routes";
import reportRoutes from "./modules/reports/report.routes";
import heldHistoryRoutes from "./modules/subscriptions/held-history.routes";


const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error(
        "Set a strong SESSION_SECRET (at least 32 characters) in your .env file."
    );
}


const requiredDbVariables = [
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
] as const;

for (const variable of requiredDbVariables) {
    if (!process.env[variable]) {
        throw new Error(
            `Missing required database environment variable: ${variable}`
        );
    }
}

const dbPort = Number(process.env.DB_PORT);

if (
    !Number.isInteger(dbPort) ||
    dbPort !== 3307 ||
    process.env.DB_NAME !== "noteto_dev" ||
    process.env.DB_USER !== "noteto_services"
) {
    throw new Error(
        "Unsafe database configuration. Expected Noteto development database."
    );
}

const dbConfig = {
    host: process.env.DB_HOST!,
    port: dbPort,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
};


const sessionPool = mysql2.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 100,
    enableKeepAlive: true,
    connectTimeout: 10000,
});

const MySQLStore = MySQLStoreFactory(session);

const sessionStore = new MySQLStore(
    {
        clearExpired: true,
        checkExpirationInterval: 15 * 60 * 1000,
        expiration: 24 * 60 * 60 * 1000,
        createDatabaseTable: false
    },
    sessionPool as unknown as ConstructorParameters<typeof MySQLStore>[1]
);
// Trust one reverse proxy only in production.
app.set(
    "trust proxy",
    process.env.NODE_ENV === "production" ? 1 : false
);

// Middleware
app.use(helmet());

app.use(
    cors({
        origin: process.env.CLIENT_URL || "http://localhost:5173",
        credentials: true,
    })
);

app.use(express.json({ limit: "20kb" }));

app.use(
    session({
        name: "noteto.sid",
        secret: SESSION_SECRET,
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 24 * 60 * 60 * 1000,
        },
    })
);


app.use("/api/transactions", transactionRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/reports", reportRoutes);

// Private development-only held-account history adapter.
// No public production routes, new entries, new invoices or new reports.
if (process.env.NODE_ENV === "development" &&
    process.env.NOTETO_HOLD_HISTORY_API_ENABLED === "true") {
    app.use("/api/hold-history", heldHistoryRoutes);
}

// Health check
app.get("/api/health", async (_req, res) => {
    try {
        await pool.query("SELECT 1");

        return res.json({
            status: "ok",
            application: "Noteto",
            database: "connected",
        });
    } catch (error) {
        console.error("Health check failed:", error);

        return res.status(503).json({
            status: "error",
            message: "Database unavailable",
        });
    }
});

// Register API routes only once.
app.use("/api/auth", authRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/business", businessRoutes);
// Development-only reconciliation evidence review.
// Never expose this route in production.
// Evidence is UNVERIFIED; no payment or subscription state changes.
if (
    process.env.NODE_ENV === "development" &&
    process.env.NOTETO_ENABLE_RECONCILIATION_REVIEW === "true"
) {
    app.use("/api", reconciliationReviewRoutes);
}




// Error-handling middleware must come last.
app.use(notFoundHandler);
app.use(errorHandler);


async function startServer(): Promise<void> {
    try {
        // Verify the actual database connection before
        // accepting HTTP requests.
        await verifyDatabaseConnection();

        console.log(
            "[STARTUP] MySQL connection verified: noteto_dev:3307"
        );

        app.listen(PORT, "127.0.0.1", () => {
            console.log(
                `[STARTUP] Noteto API running at http://127.0.0.1:${PORT}`
            );
        });
    } catch (error) {
        console.error(
            "[STARTUP] Database verification failed:",
            error
        );

        process.exitCode = 1;

        // The HTTP server has not started.
        // Exit because the database is required.
        process.exit(1);
    }
}

void startServer();
