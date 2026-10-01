import { describe, expect, it } from "vitest";
import { app, getOpenAPISpec } from "../src/api";

// Local-dev env: FAKE_ARTIFACTS_URL set means writes need no token, so these
// requests reach validation. Bindings are never touched on a 400.
const env = { FAKE_ARTIFACTS_URL: "http://localhost:8790" } as unknown as Env;
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);

describe("OpenAPI contract", () => {
  it("documents every route with an operationId", () => {
    const spec = getOpenAPISpec();
    const ops = Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p as Record<string, { operationId?: string }>).map((o) => o.operationId));
    expect(ops.sort()).toEqual(["approveCluster", "getRace", "listRaces", "pullAndonCord", "resumeRace", "startRace", "why", "writeDecisionDocs"]);
  });

  it("marks writes as admin-only and reads as open", () => {
    const spec = getOpenAPISpec();
    const paths = spec.paths as Record<string, Record<string, { security?: unknown[] }>>;
    expect(paths["/api/races"].post.security).toEqual([{ admin: [] }]);
    expect(paths["/api/races"].get.security).toEqual([]);
  });
});

describe("validation", () => {
  const good = { intent: "pin ruby", check: "bundle exec rake", k: 2, targets: [{ name: "jekyll-foo", url: "https://github.com/x/jekyll-foo" }] };

  it.each([
    ["empty intent", { ...good, intent: "  " }, "intent"],
    ["k out of range", { ...good, k: 9 }, "k"],
    ["non-https target", { ...good, targets: [{ name: "x", url: "git://github.com/x/y" }] }, "targets.0.url"],
    ["no targets", { ...good, targets: [] }, "targets"],
    ["missing check", { ...good, check: undefined }, "check"],
  ])("rejects %s with the standard error envelope", async (_name, body, field) => {
    const res = await post("/api/races", body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error.startsWith(`${field}: `)).toBe(true);
  });

  it("requires a reason to pull the andon cord", async () => {
    const res = await post("/api/races/c1/halt", { reason: " " });
    expect(res.status).toBe(400);
  });

  it("fails closed outside local dev when neither an admin token nor Access is configured", async () => {
    const res = await app.request("/api/races", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) }, {} as Env);
    expect(res.status).toBe(503);
  });
});
