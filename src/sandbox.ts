// Sandboxes run untrusted code: the repo's own and whatever agents write.
// Nothing secret goes in. Internet is off, and every HTTP(S) request leaves
// through the Egress worker below, which decides per request what's allowed
// and adds credentials on the way out. A container never sees a credential.
//
// Each sandbox has a role (see src/runtime.ts): agent, publish, verify, warm,
// land, sync, why. Roles differ only in the EgressProps they get.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { matchRepoAuth } from "./git-plan";
import { CACHE_HOST, cacheObjectKey, isCacheKey } from "./cache";
import { egressDecision } from "./egress-policy";

export interface EgressProps {
  /** Hosts the sandbox may read from (package registries, toolchain downloads). */
  allow: string[];
  /** Git remotes (URL prefix) -> repo token secret to inject as basic auth. */
  repoAuth: Record<string, string>;
  /** Fake-Artifacts host -> local URL to route it to (dev only). */
  rewrite: Record<string, string>;
  /** Dependency cache: the namespace is fixed here, never chosen by the sandbox. */
  cache: { namespace: string; write: boolean } | null;
}

export class Egress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(req: Request): Promise<Response> {
    const { allow, repoAuth, rewrite, cache } = this.ctx.props;
    const url = new URL(req.url);
    if (url.hostname === CACHE_HOST) return cache ? this.cache(req, url, cache) : deny("no cache for this sandbox");
    const secret = matchRepoAuth(`${url.origin}${url.pathname}`, repoAuth);
    if (secret) {
      const headers = new Headers(req.headers);
      headers.set("authorization", `Basic ${btoa(`x:${secret}`)}`);
      const target = rewrite[url.host] ? new URL(url.pathname + url.search, rewrite[url.host]) : url;
      return fetch(new Request(target, { method: req.method, headers, body: req.body, redirect: "manual" }));
    }
    const decision = egressDecision(req.method, url, allow);
    return decision === "allow" ? fetch(req) : deny(decision);
  }

  // The dependency cache, served from R2 under this sandbox's namespace.
  private async cache(req: Request, url: URL, cache: NonNullable<EgressProps["cache"]>): Promise<Response> {
    if (!isCacheKey(url.pathname)) return new Response("bad cache key", { status: 400 });
    const key = cacheObjectKey(cache.namespace, url.pathname);
    if (req.method === "GET" || req.method === "HEAD") {
      const obj = await this.env.CACHE.get(key);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(req.method === "HEAD" ? null : obj.body, { headers: { "content-length": String(obj.size) } });
    }
    if (req.method === "PUT") {
      // Only the warm sandbox (the repo's own setup on its base branch) writes,
      // so agent-written code can't poison what other boats restore.
      if (!cache.write) return deny("this sandbox's cache is read-only");
      const size = Number(req.headers.get("content-length"));
      if (!size || size > 2_000_000_000) return new Response("missing or oversized body", { status: 413 });
      await this.env.CACHE.put(key, req.body);
      return new Response(null, { status: 201 });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

const deny = (why: string) => new Response(`regatta egress: ${why}`, { status: 403 });

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const WORKDIR = "/workspace/repo";
const MAX_OUTPUT = 20_000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? `…[truncated ${s.length - MAX_OUTPUT} chars]\n${s.slice(-MAX_OUTPUT)}` : s);

export class Sandbox extends DurableObject<Env> {
  private container() {
    const c = this.ctx.container;
    if (!c) throw new Error("container attachment unavailable");
    return c;
  }

  /** Start (or reconfigure) the container. Safe to call repeatedly. */
  async prepare(egress: EgressProps): Promise<void> {
    const c = this.container();
    const fresh = !c.running;
    if (fresh) c.start({ image: c.images.sandbox, instance: "standard-1", enableInternet: false });
    const worker = this.ctx.exports.Egress({ props: egress });
    await c.interceptOutboundHttps("*", worker);
    await c.interceptOutboundHttp("*", worker);
    if (fresh) {
      // The intercept CA is mounted at runtime, so trust it on each start.
      await this.raw(["sh", "-c", "cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates >/dev/null"]);
      await c.setInactivityTimeout(20 * 60 * 1000);
    }
  }

  private async raw(argv: string[], cwd = "/workspace"): Promise<ExecResult> {
    const p = await this.container().exec(argv, { cwd });
    const o = await p.output();
    const d = new TextDecoder();
    return { exitCode: o.exitCode, stdout: clip(d.decode(o.stdout)), stderr: clip(d.decode(o.stderr)) };
  }

  /** Run a shell command in the repo checkout (or /workspace before clone). */
  async sh(command: string, opts: { inRepo?: boolean; timeoutSeconds?: number } = {}): Promise<ExecResult> {
    const t = opts.timeoutSeconds ?? 600;
    return this.raw(["timeout", String(t), "sh", "-c", command], opts.inRepo === false ? "/workspace" : WORKDIR);
  }

  async readFile(path: string): Promise<string | null> {
    const r = await this.sh(`cat -- ${quote(path)}`, { inRepo: !path.startsWith("/") });
    return r.exitCode === 0 ? r.stdout : null;
  }

  async writeFile(path: string, content: string): Promise<ExecResult> {
    // base64 keeps arbitrary content intact through the shell, written in
    // chunks: Linux caps a single argv string at 128 KiB.
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const inRepo = !path.startsWith("/"); // absolute paths may be written before the clone
    const tmp = `${path}.b64`;
    let r = await this.sh(`mkdir -p "$(dirname -- ${quote(path)})" && : > ${quote(tmp)}`, { inRepo });
    for (let i = 0; i < b64.length && r.exitCode === 0; i += 96_000) {
      r = await this.sh(`printf %s ${quote(b64.slice(i, i + 96_000))} >> ${quote(tmp)}`, { inRepo });
    }
    if (r.exitCode !== 0) return r;
    return this.sh(`base64 -d < ${quote(tmp)} > ${quote(path)} && rm -f ${quote(tmp)}`, { inRepo });
  }

  /**
   * Read a file exactly, or report that it's over the cap. Never truncates:
   * a clipped patch would apply as a different change than the agent made.
   */
  async readFileExact(path: string, maxBytes: number): Promise<{ content: string } | { tooLarge: number } | null> {
    const size = Number((await this.raw(["sh", "-c", `wc -c < ${quote(path)}`])).stdout.trim());
    if (!Number.isFinite(size) || size < 0) return null;
    if (size > maxBytes) return { tooLarge: size };
    const p = await this.container().exec(["cat", "--", path], { cwd: "/workspace" });
    const o = await p.output();
    if (o.exitCode !== 0) return null;
    const content = new TextDecoder().decode(o.stdout);
    return content.length === 0 && size > 0 ? null : { content };
  }

  /** Start from a clean container: every step that runs untrusted code calls this first. */
  async fresh(egress: EgressProps): Promise<void> {
    await this.destroy();
    await this.prepare(egress);
  }

  /** True when the container is up and still has the repo checkout. */
  async alive(): Promise<boolean> {
    const c = this.container();
    if (!c.running) return false;
    try {
      return (await this.raw(["test", "-d", "/workspace/repo/.git"])).exitCode === 0;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    const c = this.container();
    if (c.running) await c.destroy();
  }
}


import { quote } from "./git-plan";
export { quote };
