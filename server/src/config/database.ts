
import "dotenv/config";
import mysql from "mysql2/promise";

function requiredEnv(name: string): string {
    const value = process.env[name];

    if (!value || !value.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

const dbHost = requiredEnv("DB_HOST");
const dbPort = Number(requiredEnv("DB_PORT"));
const dbUser = requiredEnv("DB_USER");
const dbPassword = requiredEnv("DB_PASSWORD");
const dbName = requiredEnv("DB_NAME");

if (!Number.isInteger(dbPort) || dbPort !== 3307) {
    throw new Error("Noteto development MySQL must use port 3307.");
}

if (dbName !== "noteto_dev") {
    throw new Error("Unexpected database. Expected noteto_dev.");
}

if (dbUser !== "noteto_services") {
    throw new Error("Runtime database user must be noteto_services.");
}

const pool = mysql.createPool({
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 10000,

    decimalNumbers: false,
    timezone: "Z",
});

export async function verifyDatabaseConnection(): Promise<void> {
    const connection = await pool.getConnection();

    try {
        const [rows] = await connection.query(
            "SELECT DATABASE() AS database_name, @@port AS port"
        );

        const result = (
            rows as Array<{ database_name: string; port: number }>
        )[0];

        if (
            result.database_name !== "noteto_dev" ||
            Number(result.port) !== 3307
        ) {
            throw new Error("Database connection verification failed.");
        }
    } finally {
        connection.release();
    }
}

export default pool;
