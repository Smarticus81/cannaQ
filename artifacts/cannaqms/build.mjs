import { build } from "vite";

// Local .env files often set development for the API. Keep release bundles
// optimized regardless of that setting, on Windows and Unix alike.
process.env.NODE_ENV = "production";
await build({ configFile: "vite.config.ts" });
