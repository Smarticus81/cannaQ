import Anthropic from "@anthropic-ai/sdk";

/**
 * Lazily-initialized Anthropic client.
 *
 * The required env vars (AI_INTEGRATIONS_ANTHROPIC_BASE_URL and
 * AI_INTEGRATIONS_ANTHROPIC_API_KEY) are only validated the first time the
 * client is actually used, NOT at module import. This lets the server boot on
 * deployments that don't have the Anthropic AI integration provisioned; only
 * the AI-backed features (e.g. AI batch import) fail, with a clear message,
 * if they're invoked without configuration.
 */

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;

  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

  if (!baseURL || !apiKey) {
    throw new Error(
      "Anthropic AI integration is not configured. Set AI_INTEGRATIONS_ANTHROPIC_BASE_URL " +
        "and AI_INTEGRATIONS_ANTHROPIC_API_KEY to use AI features.",
    );
  }

  _client = new Anthropic({ apiKey, baseURL });
  return _client;
}

/**
 * Proxy that defers construction of the real Anthropic client until first
 * property access. Existing usage (e.g. `anthropic.messages.create(...)`) is
 * unchanged.
 */
export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
