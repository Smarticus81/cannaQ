const required = ["DATABASE_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PUBLISHABLE_KEY"];
const errors = [];
for (const name of required) {
  const value = process.env[name]?.trim();
  if (!value) errors.push(`${name} is missing.`);
  else if (value.includes("${{")) errors.push(`${name} contains an unresolved Railway reference.`);
}
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("${{")) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) errors.push("DATABASE_URL must use PostgreSQL.");
    if (url.hostname.endsWith(".railway.internal")) errors.push("Use the database's public endpoint when running locally.");
  } catch {
    errors.push("DATABASE_URL is not a valid URL.");
  }
}
if (process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY &&
    process.env.CLERK_PUBLISHABLE_KEY !== process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  errors.push("The server and browser Clerk publishable keys must match.");
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Required configuration is present and has no unresolved references. Service connectivity has not been tested.");
}
