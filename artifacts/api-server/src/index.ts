import { validateEnvironment } from "./lib/environment";

async function start() {
  const port = validateEnvironment(process.env);
  const { bootstrap } = await import("./bootstrap");
  await bootstrap(port);
}

void start().catch((error: unknown) => {
  console.error("Startup failed; refusing to serve an incomplete application.");
  console.error(error instanceof Error ? error.message : "Unknown startup error");
  process.exit(1);
});
