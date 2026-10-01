import { Hono, type MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import type { RaceSpec } from "./race";
import { UI } from "./ui";
import { why } from "./why";
import { repoHost } from "./repo-host";

export { Race } from "./race";
export { Sandbox, Egress } from "./sandbox";
export { AttemptWorkflow } from "./attempt";
export { LandWorkflow } from "./land";
export { SyncWorkflow } from "./sync";

const app = new Hono<{ Bindings: Env }>();
const index = (env: Env) => env.RACE.getByName("_index");

// One admin token guards anything that spends money or writes to repos.
// Fail closed: only local dev against the fake Artifacts runs without one.
const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.FAKE_ARTIFACTS_URL) return next();
  if (!c.env.REGATTA_ADMIN_TOKEN) return c.json({ error: "REGATTA_ADMIN_TOKEN is not configured" }, 503);
  const auth: MiddlewareHandler<{ Bindings: Env }> = bearerAuth({ token: c.env.REGATTA_ADMIN_TOKEN });
  return auth(c, next);
};

// Reads stay open so judges can browse a running race.
app.use("/api/*", async (c, next) => (c.req.method === "GET" ? next() : requireAdmin(c, next)));

app.get("/", (c) => c.html(UI));

app.get("/api/races", async (c) => c.json(await index(c.env).list()));

app.post("/api/races", async (c) => {
  const spec = await c.req.json<RaceSpec>();
  if (!spec.intent?.trim() || !spec.targets?.length || !spec.check?.trim()) {
    return c.json({ error: "intent, targets and check are required" }, 400);
  }
  spec.k = Math.min(Math.max(Number(spec.k) || 2, 1), 3);
  const id = `c${Date.now().toString(36)}`;
  await c.env.RACE.getByName(id).start(id, spec);
  await index(c.env).register(id, spec.intent);
  return c.json({ id }, 201);
});

app.get("/api/races/:id", async (c) => c.json(await c.env.RACE.getByName(c.req.param("id")).view()));

app.post("/api/races/:id/approve", async (c) => {
  const body = await c.req.json<{ key: string; overrides?: Record<string, string>; approvedBy?: string; dissent?: string; dissentResponse?: string }>();
  try {
    const landing = await c.env.RACE.getByName(c.req.param("id")).approve(body.key, {
      overrides: body.overrides,
      approvedBy: body.approvedBy?.trim() || "a human reviewer",
      dissent: body.dissent,
      dissentResponse: body.dissentResponse,
    });
    return c.json({ landing });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

// The andon cord, for humans. Agents pull it with the stop_the_line tool.
app.post("/api/races/:id/halt", async (c) => {
  const { reason, by } = await c.req.json<{ reason: string; by?: string }>();
  if (!reason?.trim()) return c.json({ error: "a reason is required" }, 400);
  await c.env.RACE.getByName(c.req.param("id")).halt({ by: by?.trim() || "a human", reason: reason.trim() });
  return c.json({ ok: true });
});

app.post("/api/races/:id/resume", async (c) => {
  const { by } = await c.req.json<{ by?: string }>().catch(() => ({ by: undefined }));
  const relaunched = await c.env.RACE.getByName(c.req.param("id")).resume(by?.trim() || "a human");
  return c.json({ ok: true, relaunched });
});

// Answers are cached per commit, so anyone can read them. A cache miss mints
// a repo token and may start a container, so it needs the admin token.
app.get("/api/why", async (c) => {
  const { repo, path, line } = c.req.query();
  if (!repo || !path || !Number(line)) return c.json({ error: "repo, path and line are required" }, 400);
  try {
    const head = (await repoHost(c.env).log(repo, "HEAD", 1))[0]?.hash;
    if (!head) return c.json({ error: `${repo} has no commits` }, 404);
    const key = `${repo}@${head}:${path}:${Number(line)}`;
    const cached = await index(c.env).cachedWhy(key);
    if (cached) return c.body(cached, 200, { "content-type": "application/json" });
    let answer: string | undefined;
    const compute = async () => {
      answer = JSON.stringify(await why(c.env, repo, path, Number(line)));
      await index(c.env).storeWhy(key, answer);
    };
    const denied = await requireAdmin(c, compute);
    if (denied) return denied;
    return c.body(answer!, 200, { "content-type": "application/json" });
  } catch (e) {
    if (e instanceof HTTPException) throw e; // bearerAuth's 401, not a lookup failure
    return c.json({ error: (e as Error).message }, 404);
  }
});

export default app;
