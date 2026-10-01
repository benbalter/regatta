// Before a race touches a repo, bring its Artifacts base up to date with
// GitHub. Bases are shared across races, so without this the second race on
// a repo would run against a stale snapshot. Public repos need no token.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { repoHost } from "./repo-host";
import { egressFor, sandboxFor, waitReady } from "./runtime";
import { quote } from "./sandbox";
import { trailers } from "./trailers";

export type SyncStatus = "imported" | "up-to-date" | "fast-forwarded" | "merged" | "conflict" | "failed";

export interface SyncParams {
  raceId: string;
  target: string;
  base: string;
  url: string;
  branch?: string;
  /** True when the race just imported the base, so it is already current. */
  fresh: boolean;
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const p = event.payload;
    const host = repoHost(this.env);
    const race = this.env.RACE.getByName(p.raceId);
    const sandbox = sandboxFor(this.env, `sync-${p.base}`);
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
            await sandbox.prepare(egressFor(this.env, { [base.remote]: token.secret }));
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
    // Racing on a conflicted or failed base would only produce noise.
    await step.do("report", () => race.synced(p.target, status, detail));
  }
}
