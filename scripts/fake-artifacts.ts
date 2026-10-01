// A local stand-in for Cloudflare Artifacts, for development without Workers Paid.
//
// The real binding is remote-only (no local simulator), so this mirrors its
// control plane over JSON and serves bare repos through `git http-backend` as
// the data plane. It is deliberately no friendlier than the real service:
// imports and forks are async, tokens carry an `?expires=` suffix, errors use
// the documented codes, and there is no merge or diff API.
//
// Run: node scripts/fake-artifacts.ts   (Node 24+, strips types natively)

import { spawn, execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";

const run = promisify(execFile);
const PORT = Number(process.env.FAKE_ARTIFACTS_PORT ?? 8790);
const ROOT = process.env.FAKE_ARTIFACTS_ROOT ?? join(process.cwd(), ".fake-artifacts");
// The host the sandbox egress Worker routes to this server.
const PUBLIC_HOST = process.env.FAKE_ARTIFACTS_HOST ?? "artifacts.regatta.local";
// Simulated latency so callers have to handle `importing`/`forking`.
const ASYNC_DELAY_MS = Number(process.env.FAKE_ARTIFACTS_DELAY_MS ?? 750);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type Status = "ready" | "importing" | "forking";
interface Repo {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  status: Status;
}
interface Token {
  id: string;
  repo: string;
  secret: string;
  scope: "read" | "write";
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

const repos = new Map<string, Repo>();
const tokens = new Map<string, Token>();
// State lives in memory, so start each run from an empty repo root.
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// No parameter properties: Node's type stripping can't handle them.
class ArtifactsError extends Error {
  code: number;
  status: number;
  constructor(name: string, code: number, status: number, message: string) {
    super(message);
    this.name = name;
    this.code = code;
    this.status = status;
  }
}
const notFound = (n: string) => new ArtifactsError("NOT_FOUND", 10200, 404, `repo ${n} not found`);

const repoPath = (name: string) => join(ROOT, `${name}.git`);
const remoteFor = (name: string) => `http://${PUBLIC_HOST}/git/${name}.git`;
const now = () => new Date().toISOString();

function requireReady(name: string): Repo {
  const repo = repos.get(name);
  if (!repo) throw notFound(name);
  if (repo.status === "importing") throw new ArtifactsError("IMPORT_IN_PROGRESS", 10302, 409, "import in progress");
  if (repo.status === "forking") throw new ArtifactsError("FORK_IN_PROGRESS", 10303, 409, "fork in progress");
  return repo;
}

function mintToken(repo: string, scope: "read" | "write", ttl = 86400) {
  if (ttl < 60 || ttl > 31_536_000) throw new ArtifactsError("INVALID_TTL", 10103, 400, "ttl out of range");
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const token: Token = {
    id: randomUUID(),
    repo,
    secret: `art_${randomBytes(18).toString("hex")}`,
    scope,
    createdAt: now(),
    expiresAt: new Date(expires * 1000).toISOString(),
    revoked: false,
  };
  tokens.set(token.id, token);
  return { token, plaintext: `${token.secret}?expires=${expires}` };
}

function startRepo(name: string, source: string | null, status: Status, description: string | null): Repo {
  if (!NAME.test(name)) throw new ArtifactsError("INVALID_REPO_NAME", 10101, 400, "invalid repo name");
  if (repos.has(name)) throw new ArtifactsError("ALREADY_EXISTS", 10201, 409, `repo ${name} exists`);
  const repo: Repo = {
    id: randomBytes(8).toString("hex"),
    name,
    description,
    defaultBranch: "main",
    createdAt: now(),
    updatedAt: now(),
    lastPushAt: null,
    source,
    readOnly: false,
    status,
  };
  repos.set(name, repo);
  return repo;
}

async function finishClone(repo: Repo, cloneArgs: string[]) {
  try {
    await new Promise((r) => setTimeout(r, ASYNC_DELAY_MS));
    await run("git", cloneArgs);
    const dir = repoPath(repo.name);
    await run("git", ["-C", dir, "config", "http.receivepack", "true"]);
    const { stdout } = await run("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"]);
    repo.defaultBranch = stdout.trim();
    repo.status = "ready";
    repo.updatedAt = now();
  } catch (e) {
    console.error(`clone failed for ${repo.name}:`, e);
    repos.delete(repo.name);
  }
}

function createResult(repo: Repo) {
  const { plaintext } = mintToken(repo.name, "write");
  return {
    id: repo.id,
    name: repo.name,
    description: repo.description,
    defaultBranch: repo.defaultBranch,
    remote: remoteFor(repo.name),
    token: plaintext,
  };
}

// --- control plane ------------------------------------------------------------

type Handler = (m: RegExpMatchArray, body: any, url: URL) => Promise<unknown> | unknown;
const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/repos$/, () => ({
    repos: [...repos.values()].map(({ status, ...r }) => ({ ...r, status })),
    total: repos.size,
  })],
  ["POST", /^\/repos$/, async (_m, body) => {
    const repo = startRepo(body.name, null, "ready", body.description ?? null);
    await run("git", ["init", "--bare", "-b", body.setDefaultBranch ?? "main", repoPath(repo.name)]);
    await run("git", ["-C", repoPath(repo.name), "config", "http.receivepack", "true"]);
    return createResult(repo);
  }],
  ["POST", /^\/repos\/import$/, (_m, body) => {
    const { source, target } = body;
    const repo = startRepo(target.name, `import:${source.url}`, "importing", target.opts?.description ?? null);
    const args = ["clone", "--bare", "--single-branch", source.url, repoPath(repo.name)];
    if (source.branch) args.splice(3, 0, "--branch", source.branch);
    if (source.depth) args.splice(3, 0, "--depth", String(source.depth));
    void finishClone(repo, args);
    return createResult(repo);
  }],
  ["GET", /^\/repos\/([^/]+)$/, (m) => {
    const repo = repos.get(m[1]);
    if (!repo) throw notFound(m[1]);
    return { ...repo, remote: remoteFor(repo.name) };
  }],
  ["DELETE", /^\/repos\/([^/]+)$/, (m) => {
    if (!repos.delete(m[1])) return false;
    rmSync(repoPath(m[1]), { recursive: true, force: true });
    return true;
  }],
  ["POST", /^\/repos\/([^/]+)\/fork$/, (m, body) => {
    const source = requireReady(m[1]);
    const repo = startRepo(body.name, `artifacts:fake/${source.name}`, "forking", body.opts?.description ?? null);
    void finishClone(repo, ["clone", "--bare", repoPath(source.name), repoPath(repo.name)]);
    return createResult(repo);
  }],
  ["POST", /^\/repos\/([^/]+)\/tokens$/, (m, body) => {
    requireReady(m[1]);
    const { token, plaintext } = mintToken(m[1], body.scope ?? "write", body.ttl);
    return { id: token.id, plaintext, scope: token.scope, expiresAt: token.expiresAt };
  }],
  ["DELETE", /^\/repos\/([^/]+)\/tokens\/([^/]+)$/, (m) => {
    const key = decodeURIComponent(m[2]).split("?expires=")[0];
    for (const t of tokens.values()) {
      if (t.repo === m[1] && (t.id === key || t.secret === key) && !t.revoked) {
        t.revoked = true;
        return true;
      }
    }
    return false;
  }],
  ["GET", /^\/repos\/([^/]+)\/log$/, async (m, _b, url) => {
    requireReady(m[1]);
    const ref = url.searchParams.get("ref") ?? "HEAD";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 1000);
    const sep = "\x1e";
    const fmt = ["%H", "%T", "%P", "%an", "%ae", "%cn", "%ce", "%at", "%ct", "%B"].join("%x1f") + sep;
    try {
      const { stdout } = await run("git", ["-C", repoPath(m[1]), "log", "--first-parent", `-n${limit}`, `--format=${fmt}`, ref]);
      return stdout.split(sep).filter((s) => s.trim()).map((rec) => {
        const [hash, treeHash, parents, an, ae, cn, ce, at, ct, message] = rec.replace(/^\n/, "").split("\x1f");
        return {
          hash, treeHash, parents: parents ? parents.split(" ") : [],
          author: { name: an, email: ae }, committer: { name: cn, email: ce },
          authoredAt: Number(at), committedAt: Number(ct), message: message.replace(/\n$/, ""),
        };
      });
    } catch {
      return []; // unresolvable ref, as documented
    }
  }],
  ["GET", /^\/repos\/([^/]+)\/file$/, async (m, _b, url) => {
    requireReady(m[1]);
    const ref = url.searchParams.get("ref");
    const path = url.searchParams.get("path");
    if (!ref || !path) throw new ArtifactsError("INVALID_INPUT", 10100, 400, "ref and path are required");
    try {
      const { stdout } = await run("git", ["-C", repoPath(m[1]), "show", `${ref}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
      return { content: stdout };
    } catch {
      return null;
    }
  }],
];

// --- data plane: git smart HTTP via git http-backend ------------------------

function authorize(req: IncomingMessage, repo: string, needWrite: boolean): boolean {
  const header = req.headers.authorization ?? "";
  let secret = "";
  if (header.startsWith("Basic ")) {
    secret = Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":");
  } else if (header.startsWith("Bearer ")) {
    secret = header.slice(7);
  }
  secret = secret.split("?expires=")[0];
  for (const t of tokens.values()) {
    if (t.repo === repo && t.secret === secret && !t.revoked && Date.parse(t.expiresAt) > Date.now()) {
      return !needWrite || t.scope === "write";
    }
  }
  return false;
}

function serveGit(req: IncomingMessage, res: ServerResponse, url: URL, name: string) {
  const isPush = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
  const repo = repos.get(name);
  if (!repo || repo.status !== "ready") return send(res, 404, "not found");
  if (!authorize(req, name, isPush)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="artifacts"' });
    return res.end();
  }
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "x",
      PATH_INFO: url.pathname.replace(/^\/git/, ""),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
    },
  });
  req.pipe(cgi.stdin);
  // Parse CGI headers, then stream the body.
  let head = Buffer.alloc(0);
  let headersSent = false;
  cgi.stdout.on("data", (chunk: Buffer) => {
    if (headersSent) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    let status = 200;
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10);
      else res.setHeader(k, v);
    }
    res.writeHead(status);
    headersSent = true;
    res.write(head.subarray(end + 4));
  });
  cgi.on("close", () => {
    if (isPush && url.pathname.endsWith("/git-receive-pack")) {
      repo.lastPushAt = repo.updatedAt = now();
    }
    res.end();
  });
  cgi.stderr.on("data", (d: Buffer) => console.error(`[git ${name}] ${d}`));
}

// --- server ---------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const git = /^\/git\/([^/]+)\.git\//.exec(url.pathname);
  if (git) return serveGit(req, res, url, git[1]);
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m || req.method !== method) continue;
    try {
      const result = await handler(m, method === "GET" || method === "DELETE" ? {} : await readJson(req), url);
      return send(res, 200, { success: true, result, errors: [] });
    } catch (e) {
      if (e instanceof ArtifactsError) {
        return send(res, e.status, { success: false, result: null, errors: [{ code: e.code, message: e.message, name: e.name }] });
      }
      console.error(e);
      return send(res, 500, { success: false, result: null, errors: [{ code: 10400, message: String(e), name: "INTERNAL_ERROR" }] });
    }
  }
  send(res, 404, { success: false, errors: [{ code: 10200, message: "no route" }] });
}).listen(PORT, () => {
  if (existsSync(ROOT)) console.log(`fake artifacts on :${PORT}, repos in ${ROOT}, remotes at http://${PUBLIC_HOST}`);
});
