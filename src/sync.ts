// Before a race touches a repo, bring its Artifacts base up to date with
// GitHub. Bases are shared across races, so without this the second race on
// a repo would run against a stale snapshot. Public repos need no token.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { repoHost } from "./repo-host";
import { egressFor, sandboxFor, sandboxId, waitReady } from "./runtime";
import { quote } from "./git-plan";
import { trailers } from "./trailers";
import { parseCacheResult, restoreScript, saveScript } from "./cache";
import { toolchainScript } from "./toolchain";

export type { SyncStatus } from "./schemas";
import type { SyncStatus } from "./schemas";

export interface SyncParams {
  raceId: string;
  target: string;
  base: string;
  url: string;
  branch?: string;
  /** True when the race just imported the base, so it is already current. */
  fresh: boolean;
  /** The repo's setup command; when set, a warm sandbox caches its result. */
  setup: string;
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  // The only sandbox allowed to write the dependency cache: it runs the repo's
  // own setup on its base branch, never agent-written code. Agent and verify
  // sandboxes only read what it saved, in this repo's namespace.
  private async warm(p: SyncParams): Promise<string> {
    const host = repoHost(this.env);
    const base = await host.info(p.base);
    const box = sandboxFor(this.env, sandboxId(p.base, "warm"));
    const token = await host.token(p.base, "read", 1800);
    try {
      await box.fresh(egressFor(this.env, "warm", { repoAuth: { [base.remote]: token.secret }, cacheNamespace: p.base }));
      const clone = await box.sh(`rm -rf repo && git clone --quiet --depth 1 ${quote(base.remote)} repo`, { inRepo: false });
      await host.revokeToken(p.base, token.id);
      if (clone.exitCode !== 0) return `cache not warmed: clone failed`;
      if (parseCacheResult((await box.sh(restoreScript(p.setup), { timeoutSeconds: 300 })).stdout).status === "hit") return "dependency cache already warm";
      await box.sh(toolchainScript(), { timeoutSeconds: 600 });
      const setup = await box.sh(p.setup, { timeoutSeconds: 900 });
      if (setup.exitCode !== 0) return `cache not warmed: setup failed (${(setup.stderr || setup.stdout).trim().split("\n").at(-1)?.slice(0, 200)})`;
      const saved = parseCacheResult((await box.sh(saveScript(p.setup), { timeoutSeconds: 600 })).stdout);
      return saved.status === "saved" ? "warmed the dependency cache from the base branch" : `cache not warmed (${saved.status})`;
    } finally {
      await host.revokeToken(p.base, token.id).catch(() => {});
      await box.destroy();
    }
  }

  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const p = event.payload;
    const host = repoHost(this.env);
    const race = this.env.Race.getByName(p.raceId);
    const sandbox = sandboxFor(this.env, sandboxId(p.base, "sync"));
    let status: SyncStatus = "failed";
    let detail = "";
    try {
      const base = await waitReady(step, host, p.base, "base");
      if (p.fresh) {
        status = "imported";
      } else {
        const result = await step.do("refresh", async () => {
          const token = await host.token(p.base, "write", 1800);
          try {
            await sandbox.fresh(egressFor(this.env, "sync", { repoAuth: { [base.remote]: token.secret }, upstream: p.url }));
            await sandbox.writeFile(
              "/workspace/.sync-msg",
              `Sync ${p.target} from upstream\n\n${trailers({ race: p.raceId, decision: `merge upstream ${p.url}` })}`,
            );
            // Exit codes: 0 up to date, 10 fast-forwarded, 11 merged, 20 conflict.
            const script = [
              "set -e",
              "rm -rf repo",
              `git clone --quiet ${quote(base.remote)} repo`,
              "cd repo",
              `git fetch --quiet ${quote(p.url)} ${p.branch ? quote(p.branch) : "HEAD"}`,
              "if git merge-base --is-ancestor FETCH_HEAD HEAD; then exit 0; fi",
              `if git merge-base --is-ancestor HEAD FETCH_HEAD; then git merge --quiet --ff-only FETCH_HEAD; git push --quiet origin HEAD:${quote(base.defaultBranch)}; exit 10; fi`,
              "if ! git -c user.name=regatta -c user.email=regatta@localhost merge --quiet --no-ff -F /workspace/.sync-msg FETCH_HEAD; then git merge --abort; exit 20; fi",
              `git push --quiet origin HEAD:${quote(base.defaultBranch)}`,
              "exit 11",
            ].join("\n");
            const r = await sandbox.sh(script, { inRepo: false, timeoutSeconds: 300 });
            const byCode: Record<number, SyncStatus> = { 0: "up-to-date", 10: "fast-forwarded", 11: "merged", 20: "conflict" };
            return { status: byCode[r.exitCode] ?? "failed", detail: byCode[r.exitCode] ? "" : (r.stderr || r.stdout).slice(-1000) };
          } finally {
            await host.revokeToken(p.base, token.id);
          }
        });
        status = result.status;
        detail = result.detail;
      }
    } catch (e) {
      status = "failed";
      detail = (e as Error).message;
    }
    await step.do("cleanup", () => sandbox.destroy());
    if (p.setup.trim() && status !== "conflict" && status !== "failed") {
      const warm = await step.do("warm", () => this.warm(p));
      await step.do("note-warm", () => race.note("warm", p.target, "", warm));
    }
    // Racing on a conflicted or failed base would only produce noise.
    await step.do("report", () => race.synced(p.target, status, detail));
  }
}
