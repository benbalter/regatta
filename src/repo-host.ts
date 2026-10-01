// The narrow slice of Artifacts that Regatta uses. Production wraps the real
// binding; local dev talks to scripts/fake-artifacts.ts, because the binding
// is remote-only and needs Workers Paid. Keep this interface no wider than
// the real API: no merge, no diff. Those happen with git inside a sandbox.

export type RepoStatus = "ready" | "importing" | "forking" | "missing";

export interface RepoRef {
  name: string;
  remote: string;
  defaultBranch: string;
}

export interface RepoToken {
  id: string;
  /** Secret without the `?expires=` suffix, ready for HTTP auth. */
  secret: string;
}

export interface RepoHost {
  importRepo(name: string, url: string, branch?: string): Promise<RepoRef>;
  fork(source: string, name: string): Promise<RepoRef>;
  info(name: string): Promise<RepoRef & { status: RepoStatus }>;
  token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<RepoToken>;
  revokeToken(name: string, id: string): Promise<boolean>;
  log(name: string, ref: string, limit: number): Promise<ArtifactsCommitMetadata[]>;
}

const stripExpiry = (t: string) => t.split("?expires=")[0];

const codeOf = (e: unknown) => String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e);

export class ArtifactsRepoHost implements RepoHost {
  constructor(private readonly artifacts: Artifacts) {}

  async importRepo(name: string, url: string, branch?: string) {
    const r = await this.artifacts.import({ source: { url, branch }, target: { name } });
    return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch };
  }

  async fork(source: string, name: string) {
    using repo = await this.artifacts.get(source);
    const r = await repo.fork(name, { defaultBranchOnly: true });
    return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch };
  }

  async info(name: string) {
    try {
      using repo = await this.artifacts.get(name);
      const i = await repo.info();
      return { name: i.name, remote: i.remote, defaultBranch: i.defaultBranch, status: "ready" as const };
    } catch (e) {
      const code = codeOf(e);
      const status: RepoStatus = code.includes("IMPORT_IN_PROGRESS") ? "importing" : code.includes("FORK_IN_PROGRESS") ? "forking" : "missing";
      if (status === "missing" && !code.includes("NOT_FOUND")) throw e;
      return { name, remote: "", defaultBranch: "", status };
    }
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number) {
    using repo = await this.artifacts.get(name);
    const t = await repo.createToken(scope, ttlSeconds);
    return { id: t.id, secret: stripExpiry(t.plaintext) };
  }

  async revokeToken(name: string, id: string) {
    using repo = await this.artifacts.get(name);
    return repo.revokeToken(id);
  }

  async log(name: string, ref: string, limit: number) {
    using repo = await this.artifacts.get(name);
    return repo.log({ ref, limit });
  }
}

export class FakeRepoHost implements RepoHost {
  constructor(private readonly base: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { success: boolean; result: T; errors: Array<{ code: number; name?: string; message: string }> };
    if (!json.success) {
      const err = json.errors[0];
      throw Object.assign(new Error(`${err?.name ?? "ERROR"} (${err?.code}): ${err?.message}`), { code: err?.name });
    }
    return json.result;
  }

  async importRepo(name: string, url: string, branch?: string) {
    const r = await this.call<RepoRef>("POST", "/repos/import", { source: { url, branch }, target: { name } });
    return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch };
  }

  async fork(source: string, name: string) {
    const r = await this.call<RepoRef>("POST", `/repos/${source}/fork`, { name });
    return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch };
  }

  async info(name: string) {
    try {
      const r = await this.call<RepoRef & { status: RepoStatus }>("GET", `/repos/${name}`);
      return { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch, status: r.status };
    } catch (e) {
      if (codeOf(e).includes("NOT_FOUND")) return { name, remote: "", defaultBranch: "", status: "missing" as const };
      throw e;
    }
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number) {
    const t = await this.call<{ id: string; plaintext: string }>("POST", `/repos/${name}/tokens`, { scope, ttl: ttlSeconds });
    return { id: t.id, secret: stripExpiry(t.plaintext) };
  }

  revokeToken(name: string, id: string) {
    return this.call<boolean>("DELETE", `/repos/${name}/tokens/${encodeURIComponent(id)}`);
  }

  log(name: string, ref: string, limit: number) {
    return this.call<ArtifactsCommitMetadata[]>("GET", `/repos/${name}/log?ref=${encodeURIComponent(ref)}&limit=${limit}`);
  }
}

export function repoHost(env: Env): RepoHost {
  return env.FAKE_ARTIFACTS_URL ? new FakeRepoHost(env.FAKE_ARTIFACTS_URL) : new ArtifactsRepoHost(env.ARTIFACTS!);
}
