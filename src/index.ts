import { Hono, type MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { CampaignSpec } from "./campaign";
import { UI } from "./ui";
import { why } from "./why";

export { Campaign } from "./campaign";
export { Sandbox, Egress } from "./sandbox";
export { AttemptWorkflow } from "./attempt";
export { LandWorkflow } from "./land";

const app = new Hono<{ Bindings: Env }>();
const index = (env: Env) => env.CAMPAIGN.getByName("_index");

// One admin token guards anything that spends money or writes to repos.
// Reads stay open so judges can browse a running campaign.
app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || !c.env.REGATTA_ADMIN_TOKEN) return next();
  const auth: MiddlewareHandler<{ Bindings: Env }> = bearerAuth({ token: c.env.REGATTA_ADMIN_TOKEN });
  return auth(c, next);
});

app.get("/", (c) => c.html(UI));

app.get("/api/campaigns", async (c) => c.json(await index(c.env).list()));

app.post("/api/campaigns", async (c) => {
  const spec = await c.req.json<CampaignSpec>();
  if (!spec.intent?.trim() || !spec.targets?.length || !spec.check?.trim()) {
    return c.json({ error: "intent, targets and check are required" }, 400);
  }
  spec.k = Math.min(Math.max(Number(spec.k) || 2, 1), 3);
  const id = `c${Date.now().toString(36)}`;
  await c.env.CAMPAIGN.getByName(id).start(id, spec);
  await index(c.env).register(id, spec.intent);
  return c.json({ id }, 201);
});

app.get("/api/campaigns/:id", async (c) => c.json(await c.env.CAMPAIGN.getByName(c.req.param("id")).view()));

app.post("/api/campaigns/:id/approve", async (c) => {
  const body = await c.req.json<{ key: string; overrides?: Record<string, string>; approvedBy?: string; dissent?: string; dissentResponse?: string }>();
  try {
    const landing = await c.env.CAMPAIGN.getByName(c.req.param("id")).approve(body.key, {
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
app.post("/api/campaigns/:id/halt", async (c) => {
  const { reason, by } = await c.req.json<{ reason: string; by?: string }>();
  if (!reason?.trim()) return c.json({ error: "a reason is required" }, 400);
  await c.env.CAMPAIGN.getByName(c.req.param("id")).halt({ by: by?.trim() || "a human", reason: reason.trim() });
  return c.json({ ok: true });
});

app.post("/api/campaigns/:id/resume", async (c) => {
  const { by } = await c.req.json<{ by?: string }>().catch(() => ({ by: undefined }));
  await c.env.CAMPAIGN.getByName(c.req.param("id")).resume(by?.trim() || "a human");
  return c.json({ ok: true });
});

app.get("/api/why", async (c) => {
  const { repo, path, line } = c.req.query();
  if (!repo || !path || !Number(line)) return c.json({ error: "repo, path and line are required" }, 400);
  try {
    return c.json(await why(c.env, repo, path, Number(line)));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 404);
  }
});

export default app;
