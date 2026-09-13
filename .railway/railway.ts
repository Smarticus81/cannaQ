import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

// One project definition: the API serves the SPA; workspace libraries are not services.
// Plan against production before applying. Keep the existing Postgres volume/data.
export default defineRailway(() => {
  const db = postgres("Postgres", { region: "iad" });
  const api = service("@workspace/api-server", {
    source: github("Smarticus81/cannaQ", {
      branch: "main",
      rootDirectory: "/",
    }),
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm build:prod",
      watchPatterns: [
        "/artifacts/api-server/**",
        "/artifacts/cannaqms/**",
        "/lib/**",
        "/scripts/**",
        "/package.json",
        "/pnpm-lock.yaml",
        "/pnpm-workspace.yaml",
        "/tsconfig*.json",
        "/.npmrc",
        "/.railway/**",
      ],
    },
    deploy: {
      startCommand: "pnpm start",
      preDeployCommand: ["pnpm db:migrate"],
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    replicas: { iad: 1 },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      NODE_ENV: "production",
      PORT: "8080",
      CLERK_SECRET_KEY: preserve(),
      CLERK_PUBLISHABLE_KEY: preserve(),
      VITE_CLERK_PUBLISHABLE_KEY: preserve(),
      BOOTSTRAP_ADMIN_EMAILS: preserve(),
    },
  });
  return project("reasonable-clarity", { resources: [db, api] });
});
