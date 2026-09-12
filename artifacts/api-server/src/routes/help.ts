// In-app help assist endpoint (Session 71, PR 3 — shipped DARK).
//
// Backs the "Ask a question" box in the "?" help popover. It is wired end-to-end
// but intentionally OFF by default: the AI only runs when HELP_AI_ENABLED is
// explicitly "true" AND the Anthropic integration is configured. Until then it
// returns { enabled: false } and never calls the model — zero spend, zero risk.
//
// To turn it on at launch: set HELP_AI_ENABLED=true and provide
// AI_INTEGRATIONS_ANTHROPIC_API_KEY / _BASE_URL (with funded credit). No code
// change needed — the same box starts returning real answers.

import { Router } from "express";
import { answerHelpQuestion } from "../lib/aiClient";

const router = Router();

function helpAiEnabled(): boolean {
  return (process.env["HELP_AI_ENABLED"] ?? "").trim().toLowerCase() === "true";
}

router.post("/help/ask", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      route?: string;
      question?: string;
      pageTitle?: string;
      pageContext?: string;
    };
    const question = (body.question ?? "").trim();
    if (!question) {
      res.status(400).json({ error: "A question is required." });
      return;
    }

    // Dark switch: when not explicitly enabled, short-circuit before any model
    // call so it's impossible to spend credits before launch.
    if (!helpAiEnabled()) {
      res.json({ enabled: false, failed: true, answer: "" });
      return;
    }

    const result = await answerHelpQuestion({
      route: body.route ?? "",
      question,
      pageTitle: body.pageTitle,
      pageContext: body.pageContext,
    });
    res.json({ enabled: true, ...result });
  } catch (err) {
    req.log.error({ err }, "Failed to answer help question");
    res.status(500).json({ error: "Failed to answer help question" });
  }
});

export default router;
