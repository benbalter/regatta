// The agent loop runs Worker-side, one model turn per Workflow step, so the
// API key stays in the Worker and a crash replays from cached turns instead
// of re-calling the model. The sandbox is only the tool executor.
//
// This is a manual loop rather than the SDK tool runner because each turn
// has to be its own durable step.

import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const MAX_TURNS = 30;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "announce",
    description:
      "Work loudly: before your first change, post your plan and the paths you expect to touch (files, directories or globs). Other agents and other races working this repo see it, and you'll be told if another race has claimed overlapping paths. Call it again if your plan changes.",
    input_schema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "One or two sentences: what you will change and why" },
        paths: { type: "array", items: { type: "string" }, description: "Paths you expect to touch, e.g. .github/workflows/ci.yml or lib/**" },
      },
      required: ["plan", "paths"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "run",
    description:
      "Run a shell command in the repository checkout (cwd is the repo root). Use it to explore, edit with sed or patch, install gems and run tests. Output is truncated to the last 20k characters.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "POSIX sh command" } },
      required: ["command"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "read_file",
    description: "Read a file from the repository checkout.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the repo root" } },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the repository checkout with the given full contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "check",
    description:
      "Run the race's check command (the repo's CI) and report pass or fail. Call this after making changes and before finishing. When a failing check later passes, your fix is shared with the other agents in this race.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "ask_fleet",
    description:
      "Look up fixes other agents in this race found for a failure. Call this when a check fails before you start debugging; another repo may already have hit and solved the same error.",
    input_schema: {
      type: "object",
      properties: { error: { type: "string", description: "The key error line from the failing output" } },
      required: ["error"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "stop_the_line",
    description:
      "Pull the andon cord: halt this whole race across every repository. Use it only when continuing would cause harm, for example the intent is unsafe, contradicts itself, or would break every repo the same way. A human will read your reason.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "What you found and why the fleet should stop" } },
      required: ["reason"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "finish",
    description:
      "End the attempt. These fields become git trailers on the commit, so `why` on any changed line answers with them later. Write them for a reviewer who wasn't here.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line commit subject" },
        problem: { type: "string", description: "What was wrong or missing in this repository, concretely" },
        alternatives: { type: "string", description: "Other approaches you considered and why you didn't take them" },
        rationale: { type: "string", description: "Why this change satisfies the intent, and anything you chose not to do" },
      },
      required: ["summary", "problem", "alternatives", "rationale"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function systemPrompt(check: string): string {
  return [
    "You are one of several agents running the same change across a fleet of repositories.",
    "Make the smallest change that satisfies the intent in this repository, matching its existing conventions.",
    "Explore first, then call announce with your plan and the paths you'll touch before you change anything. Changes outside what you announced are flagged to reviewers.",
    `The repository's check command is \`${check}\`; use the check tool to run it. Leave the repository passing.`,
    "If a check fails, call ask_fleet with the key error line before debugging on your own.",
    "Do not commit or push; Regatta commits your working tree when you call finish.",
    "If the intent does not apply to this repository, make no changes and call finish explaining why.",
  ].join("\n");
}

export function kickoff(intent: string, target: string, hints: string[]): string {
  const parts = [`Repository: ${target}`, `Intent: ${intent}`];
  if (hints.length) {
    parts.push(
      "Other agents in this race already solved failures like the one this repository hit before. Their fixes:",
      ...hints.map((h, i) => `${i + 1}. ${h}`),
    );
  }
  return parts.join("\n\n");
}

// Models are pluggable per role, as "provider:model":
//   anthropic:claude-opus-5-5          via AI Gateway (BYOK) when AI_GATEWAY_URL is set, else direct
//   ollama:qwen3.6                     local prototyping; Ollama serves the Anthropic Messages API
//   workers-ai:@cf/moonshotai/kimi-k2.6  Cloudflare Workers AI, e.g. a dissenter from a different model family
// Anthropic and Ollama share one SDK path; Workers AI goes through the AI binding.
const PROVIDERS = ["anthropic", "ollama", "workers-ai"] as const;
export interface ModelSpec {
  provider: (typeof PROVIDERS)[number];
  model: string;
}

export function parseModel(spec: string | undefined, fallback = `anthropic:${DEFAULT_MODEL}`): ModelSpec {
  const raw = spec?.trim() || fallback;
  const i = raw.indexOf(":");
  const provider = i === -1 ? "anthropic" : raw.slice(0, i);
  const model = i === -1 ? raw : raw.slice(i + 1);
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`unknown model provider "${provider}" in "${raw}"`);
  if (!model) throw new Error(`no model named in "${raw}"`);
  return { provider: provider as ModelSpec["provider"], model };
}

// Workers AI chat models answer either { response } or OpenAI-style { choices }.
async function completeWorkersAI(env: Env, model: string, system: string, user: string): Promise<string> {
  if (!env.AI) throw new Error("workers-ai provider needs the AI binding");
  const input = { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 4000 };
  // Through AI Gateway when configured, for the same logs, limits and cost data as Claude.
  const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
  const res = (await env.AI.run(model as Parameters<Ai["run"]>[0], input as never, options)) as {
    response?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = res.response ?? res.choices?.[0]?.message?.content;
  if (!text) throw new Error(`no text in Workers AI reply from ${model}`);
  return text;
}

function clientFor(env: Env, spec: ModelSpec): Anthropic {
  if (spec.provider === "ollama") {
    return new Anthropic({ apiKey: "ollama", baseURL: env.OLLAMA_URL || "http://localhost:11434" });
  }
  if (env.AI_GATEWAY_URL) {
    // BYOK: the Anthropic key lives in the gateway (Secrets Store). The Worker
    // only holds a gateway token, and the SDK's x-api-key is ignored upstream.
    return new Anthropic({
      apiKey: "stored-in-ai-gateway",
      baseURL: `${env.AI_GATEWAY_URL.replace(/\/$/, "")}/anthropic`,
      defaultHeaders: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` },
    });
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function modelTurn(
  env: Env,
  spec: ModelSpec,
  system: string,
  messages: Anthropic.Beta.BetaMessageParam[],
): Promise<Anthropic.Beta.BetaMessage> {
  if (spec.provider === "workers-ai") {
    throw new Error("workers-ai is wired for decision docs and dissents only; attempts need the tool-calling adapter (planned for the model comparison)");
  }
  const client = clientFor(env, spec);
  const body: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: spec.model,
    max_tokens: 16000,
    system,
    tools: TOOLS,
    messages,
  };
  if (spec.provider === "anthropic") {
    return client.beta.messages.create({
      ...body,
      output_config: { effort: "medium" },
      // Each turn resends the whole history, so cache the growing prefix.
      // Roughly halves model input cost across an attempt.
      cache_control: { type: "ephemeral" },
      // Re-route a classifier refusal to Anthropic's recommended fallback model
      // instead of failing the attempt.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  }
  return client.beta.messages.create(body);
}

/** A single tool-less completion, for decision docs and dissents. Returns the text. */
export async function complete(env: Env, spec: ModelSpec, system: string, user: string): Promise<string> {
  if (spec.provider === "workers-ai") return completeWorkersAI(env, spec.model, system, user);
  const client = clientFor(env, spec);
  const body: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: spec.model,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
  };
  const res =
    spec.provider === "anthropic"
      ? await client.beta.messages.create({
          ...body,
          output_config: { effort: "medium" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
      : await client.beta.messages.create(body);
  if (res.stop_reason === "refusal") throw new Error("model declined");
  return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}
