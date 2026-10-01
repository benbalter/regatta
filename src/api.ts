/**
 * Regatta's HTTP API. Every route is declared with its Zod schemas
 * (src/schemas.ts), so this file produces the OpenAPI spec, validates
 * requests, and types the handlers from one definition.
 */
import { OpenAPIHono, createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { repoHost } from "./repo-host";
import * as S from "./schemas";
import { why } from "./why";

type AppEnv = { Bindings: Env };

// Validation failures use the same { error } envelope as every other error,
// so clients handle one shape and never see raw Zod internals.
export const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      const issue = result.error.issues?.[0];
      const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
      return c.json({ error: `${where}${issue?.message ?? "invalid request"}` }, 400);
    }
  },
});

app.openAPIRegistry.registerComponent("securitySchemes", "admin", {
  type: "http",
  scheme: "bearer",
  description: "REGATTA_ADMIN_TOKEN. Required for anything that spends money or writes to repos.",
});

// One admin token guards writes. Fail closed: only local dev against the
// fake Artifacts runs without one.
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.FAKE_ARTIFACTS_URL) return next();
  if (!c.env.REGATTA_ADMIN_TOKEN) return c.json({ error: "REGATTA_ADMIN_TOKEN is not configured" }, 503);
  const auth: MiddlewareHandler<AppEnv> = bearerAuth({ token: c.env.REGATTA_ADMIN_TOKEN });
  return auth(c, next);
};

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(S.ApiError, "Malformed request"),
  401: json(S.ApiError, "Missing or wrong admin token"),
  503: json(S.ApiError, "Server has no admin token configured"),
};
const admin: RouteConfig["security"] = [{ admin: [] }];
// Public reads say so explicitly, so the spec documents intent rather than omission.
const open: RouteConfig["security"] = [];
const optionalAdmin: RouteConfig["security"] = [{}, { admin: [] }];
const RaceId = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "cmuptjeil" }) });
const index = (env: Env) => env.RACE.getByName("_index");

app.use("/api/*", async (c, next) => (c.req.method === "GET" ? next() : requireAdmin(c, next)));

app.openapi(
  createRoute({
    method: "get",
    path: "/api/races",
    operationId: "listRaces",
    summary: "List races, newest first",
    tags: ["races"],
    security: open,
    responses: { 200: json(z.array(S.RaceSummary), "Races") },
  }),
  async (c) => c.json(await index(c.env).list(), 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/races",
    operationId: "startRace",
    summary: "Start a race",
    description:
      "One intent fans out to every target as K competing agent forks. Each repo's base is synced from upstream first; agents share fixes through the race's blackboard; results collapse into outcome clusters for review.",
    tags: ["races"],
    security: admin,
    request: { body: { content: { "application/json": { schema: S.RaceSpec } }, required: true } },
    responses: { 201: json(z.object({ id: z.string() }), "Race started"), ...errors },
  }),
  async (c) => {
    const spec = c.req.valid("json");
    const id = `c${Date.now().toString(36)}`;
    await c.env.RACE.getByName(id).start(id, spec);
    await index(c.env).register(id, spec.intent);
    return c.json({ id }, 201);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/api/races/{id}",
    operationId: "getRace",
    security: open,
    summary: "A race: attempts, outcome clusters with policy verdicts, the blackboard, and sync status",
    tags: ["races"],
    request: { params: RaceId },
    responses: { 200: json(S.RaceView, "The race"), 404: json(S.ApiError, "No such race") },
  }),
  async (c) => {
    const view = await c.env.RACE.getByName(c.req.valid("param").id).view();
    if (!view) return c.json({ error: "no such race" }, 404);
    return c.json(view, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/races/{id}/approve",
    operationId: "approveCluster",
    summary: "Approve one outcome cluster and land each target's chosen fork",
    description: "Review happens once per cluster, not once per repo. The decision, approver and dissent response are recorded as trailers on each landing merge.",
    tags: ["review"],
    security: admin,
    request: { params: RaceId, body: { content: { "application/json": { schema: S.ApproveRequest } }, required: true } },
    responses: { 200: json(z.object({ landing: z.array(z.string()) }), "Attempts now landing"), 409: json(S.ApiError, "Blocked by policy or the andon cord"), ...errors },
  }),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const landing = await c.env.RACE.getByName(c.req.valid("param").id).approve(body.key, {
        overrides: body.overrides,
        approvedBy: body.approvedBy?.trim() || "a human reviewer",
        dissent: body.dissent,
        dissentResponse: body.dissentResponse,
      });
      return c.json({ landing }, 200);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/races/{id}/halt",
    operationId: "pullAndonCord",
    summary: "Pull the andon cord: stop the line",
    description: "Running attempts halt at their next step, nothing new launches and nothing lands. Agents pull the same cord with their stop_the_line tool.",
    tags: ["andon"],
    security: admin,
    request: { params: RaceId, body: { content: { "application/json": { schema: S.HaltRequest } }, required: true } },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Line stopped"), ...errors },
  }),
  async (c) => {
    const { reason, by } = c.req.valid("json");
    await c.env.RACE.getByName(c.req.valid("param").id).halt({ by: by?.trim() || "a human", reason });
    return c.json({ ok: true as const }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/api/races/{id}/resume",
    operationId: "resumeRace",
    summary: "Release the andon cord and relaunch what it stopped",
    tags: ["andon"],
    security: admin,
    request: { params: RaceId, body: { content: { "application/json": { schema: S.ResumeRequest } } } },
    responses: { 200: json(z.object({ ok: z.literal(true), relaunched: z.array(z.string()) }), "Resumed"), ...errors },
  }),
  async (c) => {
    const body = await c.req.json<{ by?: string }>().catch(() => ({ by: undefined }));
    const relaunched = await c.env.RACE.getByName(c.req.valid("param").id).resume(body.by?.trim() || "a human");
    return c.json({ ok: true as const, relaunched }, 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/api/why",
    operationId: "why",
    summary: "Why does this line exist?",
    description:
      "Blames the line, then returns the agent's problem/alternatives/rationale from its commit and the decision, approver and dissent response from the merge that landed it. Answers are cached per commit and readable by anyone; computing a new one needs the admin token.",
    tags: ["why"],
    // Cached answers are public; computing a new one needs the admin token.
    security: optionalAdmin,
    request: {
      query: z.object({
        repo: z.string().openapi({ example: "base-jekyll-titles-from-headings" }),
        path: z.string().openapi({ example: ".ruby-version" }),
        line: z.coerce.number().int().min(1).openapi({ example: 1 }),
      }),
    },
    responses: { 200: json(S.WhyAnswer, "The why"), 401: errors[401], 404: json(S.ApiError, "No such repo, file or line"), 503: errors[503] },
  }),
  async (c) => {
    const { repo, path, line } = c.req.valid("query");
    try {
      const head = (await repoHost(c.env).log(repo, "HEAD", 1))[0]?.hash;
      if (!head) return c.json({ error: `${repo} has no commits` }, 404);
      const key = `${repo}@${head}:${path}:${line}`;
      const cached = await index(c.env).cachedWhy(key);
      if (cached) return c.json(JSON.parse(cached) as S.WhyAnswer, 200);
      let answer: S.WhyAnswer | undefined;
      const denied = await requireAdmin(c, async () => {
        answer = await why(c.env, repo, path, line);
        await index(c.env).storeWhy(key, JSON.stringify(answer));
      });
      if (denied) return denied as never;
      return c.json(answer!, 200);
    } catch (e) {
      if (e instanceof HTTPException) throw e; // bearerAuth's 401, not a lookup failure
      return c.json({ error: (e as Error).message }, 404);
    }
  },
);

export function getOpenAPISpec() {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Regatta API",
      version: "0.1.0",
      description:
        "Races, not pull requests: one intent across many repos as competing agent forks that share fixes, reviewed once per outcome cluster, with an andon cord and decision provenance on every landed line.",
      license: { name: "MIT", url: "https://opensource.org/license/mit" },
      contact: { name: "Ben Balter", url: "https://ben.balter.com" },
    },
    servers: [{ url: "/", description: "This deployment" }],
    tags: [
      { name: "races", description: "Start and inspect races." },
      { name: "review", description: "Review once per outcome cluster." },
      { name: "andon", description: "Stop the line, and restart it." },
      { name: "why", description: "Decision provenance for any landed line." },
    ],
  });
}
