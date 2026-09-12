import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { facilityContext } from "./middlewares/facilityContext";
import { logger } from "./lib/logger";
import { requireActiveUser } from "./middlewares/requireActiveUser";
import { getOrProvisionCurrentUser } from "./lib/currentUser";
import healthRouter from "./routes/health";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
app.use(clerkMiddleware());

// Multi-facility Phase 2 — every API request announces the facility it is acting
// for to the database, so new records are stamped with it and (from step 2) the
// database itself refuses to return another site's rows. Mounted on /api only:
// serving the SPA's static files has no business holding a database connection.
app.use("/api", requireActiveUser(getOrProvisionCurrentUser), facilityContext(), router);

// Session 42 — serve the cannaqms SPA from a single container on Railway.
// Replit ran the api-server and the Vite dev server as separate processes;
// in Railway we collapse both into one container. The cannaqms vite build
// writes to artifacts/cannaqms/dist/public, which sits two levels up from
// artifacts/api-server/dist/index.mjs (the bundled entry point). If that
// directory exists we mount it as static + add an SPA catch-all so client-
// side router paths fall back to index.html. Logged at startup so the
// container's behavior is obvious from the runtime logs.
const cannaqmsDist = path.resolve(import.meta.dirname, "..", "..", "cannaqms", "dist", "public");
if (existsSync(cannaqmsDist)) {
  logger.info({ cannaqmsDist }, "Serving cannaqms SPA from api-server");
  app.use(express.static(cannaqmsDist));
  // Session 42 (round 7) — terminal middleware instead of `app.get("*", ...)`.
  // Express 5 routes through path-to-regexp@8 which rejects the bare "*" pattern
  // and crashes the server on startup. Middleware bypasses pattern matching
  // entirely and gives the same effect: anything that wasn't handled by /api
  // or express.static falls through to here and gets index.html for client-side
  // routing. GET-only check preserves correct verb semantics.
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(cannaqmsDist, "index.html"));
  });
} else {
  logger.warn({ cannaqmsDist }, "cannaqms dist not found — SPA will not be served by api-server");
}

export default app;
