import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import MySQLStoreFactory from "express-mysql-session";

import pool from "./config/database";
import authRoutes from "./routes/auth.routes";
import businessRoutes from "./routes/business.routes";
import { notFoundHandler, errorHandler } from "./middleware/error.middleware";
import transactionRoutes from "./routes/transaction.routes";
import "dotenv/config";


console.log("Working directory:", process.cwd());
console.log("SESSION_SECRET loaded:", Boolean(process.env.SESSION_SECRET));
console.log("SESSION_SECRET length:", process.env.SESSION_SECRET?.length ?? 0);


declare module "express-session" {
    interface SessionData {
        userId?: number;
        verifiedPhone?: string;
    }
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error(
        "Set a strong SESSION_SECRET (at least 32 characters) in your .env file."
    );
}

const dbConfig = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "msme_ledger",
};

const MySQLStore = MySQLStoreFactory(session);

const sessionStore = new MySQLStore({
    ...dbConfig,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: 24 * 60 * 60 * 1000,
    createDatabaseTable: true,
});

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


declare module "express-session" {
    interface SessionData {
        userId?: number;
        verifiedPhone?: string;
    }
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
app.use("/api/business", businessRoutes);




// Error-handling middleware must come last.
app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(`Noteto API running at http://localhost:${PORT}`);
});
