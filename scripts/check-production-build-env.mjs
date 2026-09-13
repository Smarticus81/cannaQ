import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const key = process.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
if (!key || key.includes("${{")) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY is required at build time. Set it on the API service before deploying the combined application.",
  );
}
