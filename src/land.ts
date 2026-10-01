// Land a winning attempt: merge its fork into the target's base repo. The
// Artifacts API has no merge endpoint, so this is plain git in a sandbox.
// A --no-ff merge keeps the attempt's commit (and its trailers) intact.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { repoHost } from "./repo-host";
import { egressFor, sandboxFor } from "./runtime";
import { quote } from "./sandbox";
import { trailers } from "./trailers";

export interface LandParams {
  campaignId: string;
  attemptId: string;
  target: string;
  base: string;
  fork: string;
  clusterLabel: string;
  /** Why this landed: "policy: auto" or the human decision. */
  decision: string;
  approvedBy: string;
  dissent?: string;
  dissentResponse?: string;
}

export class LandWorkflow extends WorkflowEntrypoint<Env, LandParams> {
  async run(event: WorkflowEvent<LandParams>, step: WorkflowStep) {
    const p = event.payload;
    const host = repoHost(this.env);
    const campaign = this.env.CAMPAIGN.getByName(p.campaignId);
    const sandbox = sandboxFor(this.env, `land-${p.attemptId}`);
    try {
      const halt = await step.do("gate", async () => {
        const h = await campaign.halted();
        return h ? h.reason : "";
      });
      if (halt) throw new Error(`line is stopped: ${halt}`);
      const sha = await step.do("merge", async () => {
        const base = await host.info(p.base);
        const fork = await host.info(p.fork);
        const [bt, ft] = await Promise.all([host.token(p.base, "write", 1800), host.token(p.fork, "read", 1800)]);
        try {
          await sandbox.prepare(egressFor(this.env, { [base.remote]: bt.secret, [fork.remote]: ft.secret }));
          await sandbox.writeFile("/workspace/.land-msg", mergeMessage(p));
          const script = [
            "rm -rf repo",
            `git clone --quiet ${quote(base.remote)} repo`,
            "cd repo",
            `git fetch --quiet ${quote(fork.remote)} ${quote(fork.defaultBranch)}`,
            "git -c user.name=regatta -c user.email=regatta@localhost merge --no-ff --quiet -F /workspace/.land-msg FETCH_HEAD",
            `git push --quiet origin HEAD:${quote(base.defaultBranch)}`,
            "git rev-parse HEAD",
          ].join(" && ");
          const r = await sandbox.sh(script, { inRepo: false });
          if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout);
          return r.stdout.trim().split("\n").at(-1) ?? "";
        } finally {
          await Promise.all([host.revokeToken(p.base, bt.id), host.revokeToken(p.fork, ft.id)]);
        }
      });
      await step.do("record", () => campaign.landed(p.attemptId, sha, null));
    } catch (e) {
      await step.do("record-error", () => campaign.landed(p.attemptId, null, (e as Error).message));
    } finally {
      await step.do("cleanup", () => sandbox.destroy());
    }
  }
}

// The merge commit is where the human (or policy) decision lives, so `why`
// can answer "who decided this, and what did they say to the dissent?"
function mergeMessage(p: LandParams): string {
  return `Land ${p.target} from campaign ${p.campaignId}\n\n${p.clusterLabel}\n\n${trailers({
    campaign: p.campaignId,
    attempt: p.attemptId,
    decision: p.decision,
    approvedBy: p.approvedBy,
    dissent: p.dissent,
    dissentResponse: p.dissentResponse,
  })}`;
}
