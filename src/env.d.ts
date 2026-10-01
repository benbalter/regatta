// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
// Set locally in .dev.vars, in production with `wrangler secret put`.
interface Env {
  /** Direct Anthropic access. Unused when AI_GATEWAY_URL is set (BYOK). */
  ANTHROPIC_API_KEY?: string;
  /** e.g. https://gateway.ai.cloudflare.com/v1/<account>/<gateway> */
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  /** Gateway id for Workers AI calls through AI Gateway (env.AI.run's gateway option). */
  AI_GATEWAY_ID?: string;
  /** Bearer token for POST endpoints. Unset in local dev means open. */
  REGATTA_ADMIN_TOKEN?: string;
}
