// One container per attempt. Agent-written code and the repo's own test suite
// run here, so nothing secret goes in: internet is off, and every HTTP(S)
// request leaves through the Egress worker, which allowlists hosts and adds
// the Artifacts token on the way out. The container never sees a credential.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { matchRepoAuth } from "./git-plan";

export interface EgressProps {
  /** Hosts the sandbox may reach directly (package registries). */
  allow: string[];
  /** Git remotes (URL prefix) -> repo token secret to inject as basic auth. */
  repoAuth: Record<string, string>;
  /** Fake-Artifacts host -> local URL to route it to (dev only). */
  rewrite: Record<string, string>;
}

export class Egress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(req: Request): Promise<Response> {
    const { allow, repoAuth, rewrite } = this.ctx.props;
    const url = new URL(req.url);
    const secret = matchRepoAuth(`${url.origin}${url.pathname}`, repoAuth);
    if (secret) {
      const headers = new Headers(req.headers);
      headers.set("authorization", `Basic ${btoa(`x:${secret}`)}`);
      const target = rewrite[url.host] ? new URL(url.pathname + url.search, rewrite[url.host]) : url;
      return fetch(new Request(target, { method: req.method, headers, body: req.body, redirect: "manual" }));
    }
    if (allow.includes(url.hostname)) return fetch(req);
    return new Response(`regatta egress: ${url.hostname} is not allowed`, { status: 403 });
  }
}

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
    // base64 keeps arbitrary content intact through the shell.
    const b64 = toBase64(new TextEncoder().encode(content));
    // Absolute paths may be written before the repo is cloned, so run them from /workspace.
    return this.sh(`mkdir -p "$(dirname -- ${quote(path)})" && printf %s ${quote(b64)} | base64 -d > ${quote(path)}`, {
      inRepo: !path.startsWith("/"),
    });
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

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

import { quote } from "./git-plan";
export { quote };
