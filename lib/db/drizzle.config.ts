import { defineConfig } from "drizzle-kit";
import { loadEnvFile } from "node:process";
import path from "node:path";

try {
  loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Relative, forward-slash path — drizzle-kit runs with cwd = lib/db (the package
  // dir) via its `push` script, so this resolves on both Windows and Linux. The old
  // path.join(__dirname, …) produced Windows backslashes the globber couldn't match
  // ("No schema files found"), which blocked `push` from a Windows shell.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
