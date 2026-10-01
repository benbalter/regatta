// Regatta over MCP, so agents can operate it: start a race, read its outcome
// clusters, pull the andon cord, answer a dissent, ask why a line exists.
// Same Race methods as the HTTP API, same fail-closed admin rule for writes.
// Uses the Agents SDK's stateless handler (McpAgent is deprecated).

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { repoHost } from "./repo-host";
import { why } from "./why";
import { summarize } from "./race-logic";
import { approverFor, authorize, type Auth } from "./auth";

type Ctx = { requestInfo?: Request };
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ ...text(message), isError: true });

const DENIED = "This tool changes repos or spends money: sign in with Cloudflare Access or send `Authorization: Bearer <REGATTA_ADMIN_TOKEN>`.";

function createServer(env: Env, ctx: Ctx, auth: Auth) {
  const server = new McpServer({ name: "regatta", version: "0.1.0" });
  const race = (id: string) => env.Race.getByName(id);
  const index = () => env.Race.getByName("_index");
  const writable = auth.ok;

  server.registerTool(
    "list_races",
    { description: "List Regatta races, newest first.", inputSchema: {} },
    async () => text(await index().list()),
  );

  server.registerTool(
    "start_race",
    {
      description:
        "Start a race: one intent across many repos, K competing agent forks per repo that share fixes. Returns the race id; poll race_status for outcome clusters.",
      inputSchema: {
        intent: z.string().min(1).describe("What every repo should end up with"),
        repos: z.array(z.string().url().startsWith("https://")).min(1).max(50).describe("Public HTTPS git URLs"),
        setup: z.string().default("").describe("Shell command that installs dependencies, e.g. `npm ci`"),
        check: z.string().min(1).describe("Shell command that defines passing, e.g. `npm test`"),
        k: z.number().int().min(1).max(3).default(2).describe("Competing forks per repo"),
      },
    },
    async ({ intent, repos, setup, check, k }) => {
      if (!writable) return fail(DENIED);
      const id = `c${Date.now().toString(36)}`;
      const targets = repos.map((url) => ({ url, name: url.replace(/\.git$/, "").split("/").filter(Boolean).at(-1) ?? url }));
      await race(id).start(id, { intent, targets, setup, check, k });
      await index().register(id, intent);
      return text({ id, repos: targets.length, k });
    },
  );

  server.registerTool(
    "race_status",
    {
      description: "A race's state: boats by outcome, outcome clusters with policy verdicts and decision docs, shared fixes, and the recent log.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const v = await race(id).view();
      return v ? text(summarize(v)) : fail(`no race ${id}`);
    },
  );

  server.registerTool(
    "approve_cluster",
    {
      description:
        "Approve one outcome cluster and land each repo's chosen fork. If the cluster's decision doc has a dissent, dissent_response is required and is recorded on each landing merge.",
      inputSchema: {
        id: z.string(),
        key: z.string().describe("Cluster key from race_status"),
        approved_by: z.string().describe("Who is approving"),
        dissent_response: z.string().optional(),
      },
    },
    async ({ id, key, approved_by, dissent_response }) => {
      if (!writable) return fail(DENIED);
      try {
        return text({ landing: await race(id).approve(key, { approvedBy: approverFor(auth, approved_by), dissentResponse: dissent_response }) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "pull_andon_cord",
    {
      description: "Stop the line: every agent in the race halts at its next step and nothing lands until resumed. Give the reason a human will read.",
      inputSchema: { id: z.string(), reason: z.string().min(1), by: z.string().default("an MCP client") },
    },
    async ({ id, reason, by }) => {
      if (!writable) return fail(DENIED);
      await race(id).halt({ by, reason });
      return text("Line stopped.");
    },
  );

  server.registerTool(
    "resume_race",
    { description: "Release the andon cord and relaunch what it stopped.", inputSchema: { id: z.string(), by: z.string().default("an MCP client") } },
    async ({ id, by }) => {
      if (!writable) return fail(DENIED);
      return text({ relaunched: await race(id).resume(by) });
    },
  );

  server.registerTool(
    "why",
    {
      description:
        "Why does this line exist? Returns the agent's problem, alternatives and rationale from the commit, and the decision, approver and dissent response from the merge that landed it.",
      inputSchema: { repo: z.string().describe("Base repo name from race_status, e.g. base-my-repo-1a2b3c4d5e6f"), path: z.string(), line: z.number().int().min(1) },
    },
    async ({ repo, path, line }) => {
      // Computing an answer mints a token and may start a container, so it's a write-gated action here.
      if (!writable) return fail(DENIED);
      try {
        if (!(await repoHost(env).log(repo, "HEAD", 1)).length) return fail(`${repo} has no commits`);
        return text(await why(env, repo, path, line));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Authorize once per request; read tools stay open, write tools check `auth.ok`.
  const auth = await authorize(env, request);
  return createMcpHandler((mcpCtx) => createServer(env, mcpCtx as Ctx, auth))(request, env, ctx);
}
