import "dotenv/config";
import { defineConfig } from "prisma/config";

function buildDatabaseUrl(prefix: string): string {
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const name = process.env.DB_NAME;

  const user = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASSWORD`];

  if (!host || !port || !name || !user || !password) {
    throw new Error(`Missing database configuration for ${prefix}`);
  }

  return (
    `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(name)}`
  );
}

const migrationUrl = buildDatabaseUrl("MIGRATION_DB");

export default defineConfig({
  schema: "prisma/schema.prisma",

  datasource: {
    url: migrationUrl,
  },

  skills: {
    agents: ["claude", "cursor", "agents", "devin"],
  },
});