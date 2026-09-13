import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { isReady } from "../lib/readiness";

const router: IRouter = Router();

router.get(["/health", "/healthz"], (_req, res) => {
  if (!isReady()) {
    res.status(503).json({ status: "starting" });
    return;
  }
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
