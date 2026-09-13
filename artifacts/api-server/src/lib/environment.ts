/** Validate before importing modules that open database or authentication clients. */
export function validateEnvironment(env: NodeJS.ProcessEnv): number {
  const required = [
    "DATABASE_URL",
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
  ];
  if (env.NODE_ENV === "production")
    required.push("VITE_CLERK_PUBLISHABLE_KEY");
  const problems: string[] = [];
  for (const name of required) {
    if (!env[name]?.trim()) problems.push(`${name} is required`);
    else if (env[name]?.includes("${{"))
      problems.push(`${name} contains an unresolved Railway reference`);
  }
  if (env.DATABASE_URL && !env.DATABASE_URL.includes("${{")) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(url.protocol))
        throw new Error();
    } catch {
      problems.push("DATABASE_URL must be a PostgreSQL connection URL");
    }
  }
  if (
    env.CLERK_PUBLISHABLE_KEY &&
    env.VITE_CLERK_PUBLISHABLE_KEY &&
    env.CLERK_PUBLISHABLE_KEY !== env.VITE_CLERK_PUBLISHABLE_KEY
  ) {
    problems.push(
      "CLERK_PUBLISHABLE_KEY and VITE_CLERK_PUBLISHABLE_KEY must match",
    );
  }
  const port = Number(env.PORT ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    problems.push("PORT must be an integer from 1 to 65535");
  const poolMax = Number(env.DATABASE_POOL_MAX ?? "30");
  if (!Number.isInteger(poolMax) || poolMax < 1)
    problems.push("DATABASE_POOL_MAX must be a positive integer");
  if (Boolean(env.SERVICE_API_TOKEN) !== Boolean(env.SERVICE_API_USER_EMAIL)) {
    problems.push(
      "SERVICE_API_TOKEN and SERVICE_API_USER_EMAIL must be configured together",
    );
  }
  if (problems.length)
    throw new Error(
      `Invalid application configuration:\n- ${problems.join("\n- ")}`,
    );
  return port;
}
