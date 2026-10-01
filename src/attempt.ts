// One agent attempt at one target: fork, clone into a sandbox, run the agent
// loop, verify, commit with trailers, push to the fork, report. Every model
// turn and tool batch is its own durable step.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";
import { MAX_TURNS, kickoff, modelTurn, parseModel, systemPrompt } from "./agent";
import { errorSignature } from "./cluster";
import { repoHost, type RepoHost } from "./repo-host";
import { egressFor, sandboxFor, waitReady } from "./runtime";
import { trailers } from "./trailers";
import { commitPlan, commitSubject } from "./git-plan";
import { quote } from "./sandbox";

export interface AttemptParams {
  campaignId: string;
  attemptId: string;
  target: string;
  base: string;
  fork: string;
  intent: string;
  check: string;
  hints: string[];
}

export interface AttemptReport {
  attemptId: string;
  target: string;
  green: boolean;
  changedFiles: string[];
  failureLog: string;
  diffSize: number;
  diff: string;
  summary: string;
  rationale: string;
  problem: string;
  alternatives: string;
  headSha: string | null;
  turns: number;
  error?: string;
  /** Set when the attempt stopped because someone pulled the andon cord. */
  halted?: boolean;
}

/** Thrown when the campaign's andon cord is pulled mid-attempt. */
class Halted extends Error {}

const TOKEN_TTL = 3 * 60 * 60;

export class AttemptWorkflow extends WorkflowEntrypoint<Env, AttemptParams> {
  async run(event: WorkflowEvent<AttemptParams>, step: WorkflowStep) {
    const p = event.payload;
    const host = repoHost(this.env);
    const campaign = this.env.CAMPAIGN.getByName(p.campaignId);
    const sandbox = sandboxFor(this.env, p.attemptId);

    try {
      await waitReady(step, host, p.base, "base");
      await step.do("fork", async () => {
        if ((await host.info(p.fork)).status === "missing") await host.fork(p.base, p.fork);
      });
      const fork = await waitReady(step, host, p.fork, "fork");

      const { tokenId, baseSha } = await step.do("sandbox", async () => {
        const token = await host.token(p.fork, "write", TOKEN_TTL);
        try {
          await sandbox.prepare(egressFor(this.env, { [fork.remote]: token.secret }));
          const r = await sandbox.sh(`rm -rf repo && git clone --quiet ${quote(fork.remote)} repo`, { inRepo: false });
          if (r.exitCode !== 0) throw new Error(`clone failed: ${r.stderr}`);
          // Diffs are taken against this, not the index, so a retried commit step reports the same change.
          const base = (await sandbox.sh("git rev-parse HEAD")).stdout.trim();
          return { tokenId: token.id, baseSha: base };
        } catch (e) {
          // Each retry mints a new token; don't leave the failed one live.
          await host.revokeToken(p.fork, token.id);
          throw e;
        }
      });

      const result = await this.agentLoop(p, step, sandbox, campaign);

      const report = await step.do("commit", async () => {
        await this.requireSandbox(sandbox);
        const verify = await sandbox.sh(p.check, { timeoutSeconds: 900 });
        const green = verify.exitCode === 0;
        await sandbox.sh("git add -A");
        const staged = (await sandbox.sh("git diff --cached --quiet")).exitCode !== 0;
        const headMsg = (await sandbox.sh("git log -1 --format=%B")).stdout;
        const ahead = Number((await sandbox.sh(`git rev-list --count ${quote(`origin/${fork.defaultBranch}`)}..HEAD`)).stdout.trim()) > 0;
        const plan = commitPlan({ staged, headIsOurs: headMsg.includes(`Regatta-Attempt: ${p.attemptId}`), aheadOfOrigin: ahead });

        if (plan.commit) {
          const msg = `${commitSubject(result.summary, p.intent)}\n\n${trailers({
            campaign: p.campaignId,
            attempt: p.attemptId,
            intent: p.intent,
            problem: result.problem || "(none given)",
            alternatives: result.alternatives || "(none given)",
            rationale: result.rationale || "(none given)",
          })}`;
          // Via a file, so agent-written text can't break shell quoting.
          await sandbox.writeFile("/workspace/.commit-msg", msg);
          const commit = await sandbox.sh("git -c user.name=regatta -c user.email=regatta@localhost commit --quiet -F /workspace/.commit-msg");
          if (commit.exitCode !== 0) throw new Error(`commit failed: ${commit.stderr}`);
        }
        if (plan.push) {
          const push = await sandbox.sh(`git push --quiet origin HEAD:${quote(fork.defaultBranch)}`);
          if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr}`);
        }

        // Everything below compares against the clone's base, so it is stable across retries.
        const range = `${baseSha}..HEAD`;
        const changedFiles = (await sandbox.sh(`git diff --name-only ${range}`)).stdout.split("\n").filter(Boolean);
        const diffSize = (await sandbox.sh(`git diff --numstat ${range}`)).stdout
          .split("\n")
          .filter(Boolean)
          .reduce((n, l) => n + l.split("\t").slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0);
        const diff = (await sandbox.sh(`git diff ${range}`)).stdout;
        const head = (await sandbox.sh("git rev-parse HEAD")).stdout.trim();
        return {
          attemptId: p.attemptId,
          target: p.target,
          green,
          changedFiles,
          failureLog: green ? "" : (verify.stdout + verify.stderr).slice(-4000),
          diffSize,
          diff: diff.slice(0, 60_000),
          summary: result.summary,
          rationale: result.rationale,
          problem: result.problem,
          alternatives: result.alternatives,
          headSha: head === baseSha ? null : head,
          turns: result.turns,
        } satisfies AttemptReport;
      });

      await step.do("report", () => campaign.report(report));
      await step.do("cleanup", async () => {
        await host.revokeToken(p.fork, tokenId);
        await sandbox.destroy();
      });
    } catch (e) {
      // Report infrastructure failures and halts too, so the campaign never waits forever.
      const halted = e instanceof Halted;
      await step.do("report-error", () =>
        campaign.report({
          attemptId: p.attemptId,
          target: p.target,
          green: false,
          changedFiles: [],
          failureLog: halted ? `halted: ${(e as Error).message}` : `regatta error: ${(e as Error).message}`,
          diffSize: 0,
          diff: "",
          summary: "",
          rationale: "",
          problem: "",
          alternatives: "",
          headSha: null,
          turns: 0,
          error: (e as Error).message,
          halted,
        }),
      );
      await step.do("cleanup-after-error", () => sandbox.destroy());
    }
  }

  private async agentLoop(
    p: AttemptParams,
    step: WorkflowStep,
    sandbox: ReturnType<typeof sandboxFor>,
    campaign: ReturnType<Env["CAMPAIGN"]["getByName"]>,
  ) {
    const model = parseModel(this.env.REGATTA_AGENT_MODEL);
    const system = systemPrompt(p.check);
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: kickoff(p.intent, p.target, p.hints) }];
    const ledger = { summary: "", rationale: "", problem: "", alternatives: "" };
    let nudged = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // The andon cord: anyone can stop the line, and every turn honors it.
      const halt = await step.do(`gate-${turn}`, async () => {
        const h = await campaign.halted();
        return h ? `${h.reason} (by ${h.by})` : "";
      });
      if (halt) throw new Halted(halt);

      // Steps persist JSON strings: SDK types aren't structurally "Serializable".
      const res = JSON.parse(
        await step.do(`turn-${turn}`, { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
          const r = await modelTurn(this.env, model, system, messages);
          return JSON.stringify({ content: r.content, stop_reason: r.stop_reason });
        }),
      ) as { content: Anthropic.Beta.BetaContentBlock[]; stop_reason: string };

      if (res.stop_reason === "refusal") throw new Error("model declined the task");
      messages.push({ role: "assistant", content: res.content });

      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!calls.length) {
        if (nudged) break;
        nudged = true;
        messages.push({ role: "user", content: "Call the finish tool to end the attempt." });
        continue;
      }

      const finish = calls.find((c) => c.name === "finish");
      if (finish) {
        Object.assign(ledger, finish.input as typeof ledger);
        return { ...ledger, turns: turn + 1 };
      }

      const results = JSON.parse(
        // No retries: tools have side effects (blackboard posts, the andon cord).
        // Errors inside a tool go back to the model as is_error results instead.
        await step.do(`tools-${turn}`, { retries: { limit: 0, delay: "1 second" } }, async () => {
          await this.requireSandbox(sandbox);
          const out: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const call of calls) out.push(await this.runTool(call, p, sandbox, campaign));
          return JSON.stringify(out);
        }),
      ) as Anthropic.Beta.BetaToolResultBlockParam[];
      messages.push({ role: "user", content: results });
    }
    return { ...ledger, turns: MAX_TURNS };
  }

  // Model turns replay from cached steps, but the container's checkout does
  // not survive a restart. Fail the attempt with a clear reason instead of
  // letting every later tool error confusingly.
  private async requireSandbox(sandbox: ReturnType<typeof sandboxFor>) {
    if (!(await sandbox.alive())) {
      throw new Error("sandbox lost: the container restarted and its checkout is gone; rerun the attempt");
    }
  }

  private async runTool(
    call: Anthropic.Beta.BetaToolUseBlock,
    p: AttemptParams,
    sandbox: ReturnType<typeof sandboxFor>,
    campaign: ReturnType<Env["CAMPAIGN"]["getByName"]>,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const input = call.input as Record<string, string>;
    const done = (content: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: content || "(no output)",
      is_error: isError,
    });
    switch (call.name) {
      case "run": {
        const r = await sandbox.sh(input.command);
        return done(`exit ${r.exitCode}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`, r.exitCode !== 0);
      }
      case "read_file": {
        const c = await sandbox.readFile(input.path);
        return c === null ? done(`cannot read ${input.path}`, true) : done(c);
      }
      case "write_file": {
        const r = await sandbox.writeFile(input.path, input.content);
        return r.exitCode === 0 ? done(`wrote ${input.path}`) : done(r.stderr, true);
      }
      case "check":
        return done(await this.check(p, sandbox, campaign));
      case "stop_the_line": {
        await campaign.halt({ by: p.attemptId, reason: input.reason });
        return done("Line stopped. Every agent in this campaign will halt at its next step.");
      }
      case "ask_fleet": {
        const fixes = await campaign.lookup(input.error);
        return done(
          fixes.length
            ? fixes.map((f) => `From ${f.target} (error: ${f.signature}):\n${f.rationale}\nDiff:\n${f.diff}`).join("\n\n---\n\n")
            : "No other agent has reported a fix for this error yet.",
        );
      }
      default:
        return done(`unknown tool ${call.name}`, true);
    }
  }

  // Runs the check. When a check passes after an earlier failure, the diff
  // between the two states is this agent's fix, so post it to the campaign
  // blackboard for every other agent.
  private async check(p: AttemptParams, sandbox: ReturnType<typeof sandboxFor>, campaign: ReturnType<Env["CAMPAIGN"]["getByName"]>) {
    const r = await sandbox.sh(p.check, { timeoutSeconds: 900 });
    const output = (r.stdout + r.stderr).slice(-6000);
    const stateFile = "/workspace/.regatta-last-failure";
    if (r.exitCode !== 0) {
      const tree = (await sandbox.sh("git add -A && git write-tree && git reset --quiet")).stdout.trim();
      await sandbox.writeFile(stateFile, JSON.stringify({ tree, log: output }));
      return `CHECK FAILED (exit ${r.exitCode})\n${output}`;
    }
    const prior = await sandbox.readFile(stateFile);
    if (prior) {
      const { tree, log } = JSON.parse(prior) as { tree: string; log: string };
      const diff = (await sandbox.sh(`git add -A && git diff --cached ${quote(tree)} && git reset --quiet`)).stdout;
      await sandbox.sh(`rm -f ${stateFile}`);
      if (diff.trim()) {
        await campaign.postFix({ attemptId: p.attemptId, target: p.target, signature: errorSignature(log), errorLog: log.slice(-1500), diff: diff.slice(0, 8000), rationale: "Fixed a failing check; see diff." });
        return `CHECK PASSED. Your fix for the earlier failure was shared with the fleet.\n${output.slice(-1500)}`;
      }
    }
    return `CHECK PASSED\n${output.slice(-1500)}`;
  }
}
