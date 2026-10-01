// One agent attempt at one repo, under a model where every repo and every
// agent is untrusted:
//
//   agent    a fresh sandbox with a *read-only* clone. The agent explores,
//            edits and runs the check there. Its only output is a patch.
//   publish  a fresh git-only sandbox: applies the patch, commits it with the
//            attempt's trailers and pushes to the fork. Runs no repo code, so
//            the write token never meets untrusted code.
//   verify   a fresh sandbox with a read-only clone of what was pushed: runs
//            setup and the check. Only its exit code is trusted.
//
// The agent's container never grades its own work, never holds a write
// token, and never decides what was changed (the Worker parses the patch).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type Anthropic from "@anthropic-ai/sdk";
import { MAX_TURNS, kickoff, modelTurn, parseModel, systemPrompt } from "./agent";
import { errorSignature } from "./cluster";
import { repoHost } from "./repo-host";
import { egressFor, sandboxFor, sandboxId, waitReady } from "./runtime";
import { trailers } from "./trailers";
import { commitSubject, parsePatch, quote, untrusted } from "./git-plan";
import { parseCacheResult, restoreScript } from "./cache";
import { toolchainScript } from "./toolchain";
import { FORK_READY } from "./events";
import type { AttemptReport, Usage } from "./schemas";

export type { AttemptReport } from "./schemas";

export interface AttemptParams {
  raceId: string;
  attemptId: string;
  target: string;
  base: string;
  fork: string;
  intent: string;
  /** Install dependencies (optional); runs in agent and verify sandboxes. */
  setup: string;
  /** What passing means; only the verify sandbox's result counts. */
  check: string;
  hints: string[];
}

/** Thrown when the andon cord stops this repo (or the whole race). */
class Halted extends Error {}

const READ_TTL = 3 * 60 * 60;
// Patches travel through Workflow step results (1 MiB max), so cap below that.
// Over the cap the attempt goes red; a partial patch is never applied.
const MAX_PATCH_BYTES = 900_000;
const WORK = "/workspace";

type Race = ReturnType<Env["Race"]["getByName"]>;
type Box = ReturnType<typeof sandboxFor>;

export class AttemptWorkflow extends WorkflowEntrypoint<Env, AttemptParams> {
  async run(event: WorkflowEvent<AttemptParams>, step: WorkflowStep) {
    const p = event.payload;
    const host = repoHost(this.env);
    const race = this.env.Race.getByName(p.raceId);
    const agentBox = sandboxFor(this.env, sandboxId(p.attemptId, "agent"));
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    try {
      await waitReady(step, host, p.base, "base");
      await step.do("fork", async () => {
        if ((await host.info(p.fork)).status === "missing") await host.fork(p.base, p.fork);
      });
      // With Artifacts events on, the Queue consumer wakes us when the fork is
      // ready (events sent early are buffered). Polling is the fallback, and
      // the only path against the local fake.
      if (this.env.ARTIFACTS_EVENTS === "on") {
        try {
          await step.waitForEvent("fork-ready", { type: FORK_READY, timeout: "3 minutes" });
        } catch {
          /* timed out: fall back to polling */
        }
      }
      const fork = await waitReady(step, host, p.fork, "fork");

      // --- agent: untrusted work in a read-only checkout -------------------
      const { baseSha } = await step.do("agent-sandbox", async () => {
        const token = await host.token(p.fork, "read", READ_TTL);
        try {
          await agentBox.fresh(egressFor(this.env, "agent", { repoAuth: { [fork.remote]: token.secret }, cacheNamespace: p.base }));
          const clone = await agentBox.sh(`rm -rf repo && git clone --quiet ${quote(fork.remote)} repo`, { inRepo: false });
          if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr}`);
          const sha = (await agentBox.sh("git rev-parse HEAD")).stdout.trim();
          await this.prepareToolchain(agentBox, p, race, "agent");
          return { baseSha: sha };
        } finally {
          // The clone is done; the agent never needs repo access again.
          await host.revokeToken(p.fork, token.id);
        }
      });

      const result = await this.agentLoop(p, step, agentBox, race, usage);

      const exported = await step.do("export-patch", async () => {
        await this.requireSandbox(agentBox);
        await agentBox.sh(`git add -A && git diff --cached --binary ${quote(baseSha)} > ${WORK}/out.patch; git reset --quiet`);
        const read = await agentBox.readFileExact(`${WORK}/out.patch`, MAX_PATCH_BYTES);
        await agentBox.destroy();
        if (!read) throw new Error("could not read the agent's patch");
        if ("tooLarge" in read) return { patch: "", tooLarge: read.tooLarge };
        return { patch: read.content, tooLarge: 0 };
      });
      if (exported.tooLarge) throw new Error(`patch is ${exported.tooLarge} bytes, over the ${MAX_PATCH_BYTES}-byte limit; nothing was applied`);
      const { changedFiles, diffSize } = parsePatch(exported.patch);

      // --- publish: trusted git-only sandbox, the only place a write token exists ---
      const headSha = await step.do("publish", async () => {
        if (!exported.patch.trim()) return baseSha; // nothing to publish
        const box = sandboxFor(this.env, sandboxId(p.attemptId, "publish"));
        const token = await host.token(p.fork, "write", 1800);
        try {
          await box.fresh(egressFor(this.env, "publish", { repoAuth: { [fork.remote]: token.secret } }));
          const clone = await box.sh(`rm -rf repo && git clone --quiet ${quote(fork.remote)} repo`, { inRepo: false });
          if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr}`);
          // Idempotent: a retry after a successful push finds its own commit at the head.
          const head = await box.sh("git log -1 --format=%H%n%B");
          if (head.stdout.includes(`Regatta-Attempt: ${p.attemptId}`)) return head.stdout.split("\n")[0].trim();
          await box.writeFile(`${WORK}/in.patch`, exported.patch);
          const apply = await box.sh(`git apply --check --binary ${WORK}/in.patch && git apply --binary --index ${WORK}/in.patch`);
          if (apply.exitCode !== 0) throw new Error(`patch does not apply cleanly: ${apply.stderr.slice(0, 500)}`);
          const msg = `${commitSubject(result.summary, p.intent)}\n\n${trailers({
            race: p.raceId,
            attempt: p.attemptId,
            intent: p.intent,
            problem: result.problem || "(none given)",
            alternatives: result.alternatives || "(none given)",
            rationale: result.rationale || "(none given)",
          })}`;
          await box.writeFile(`${WORK}/commit-msg`, msg);
          const commit = await box.sh(`git commit --quiet --no-verify -F ${WORK}/commit-msg`);
          if (commit.exitCode !== 0) throw new Error(`commit failed: ${commit.stderr}`);
          const push = await box.sh(`git push --quiet origin HEAD:${quote(fork.defaultBranch)}`);
          if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr}`);
          return (await box.sh("git rev-parse HEAD")).stdout.trim();
        } finally {
          await host.revokeToken(p.fork, token.id);
          await box.destroy();
        }
      });

      // --- verify: a fresh sandbox decides pass/fail -------------------------
      const verdict = await step.do("verify", async () => {
        const box = sandboxFor(this.env, sandboxId(p.attemptId, "verify"));
        const token = await host.token(p.fork, "read", 1800);
        try {
          await box.fresh(egressFor(this.env, "verify", { repoAuth: { [fork.remote]: token.secret }, cacheNamespace: p.base }));
          const clone = await box.sh(`rm -rf repo && git clone --quiet ${quote(fork.remote)} repo && cd repo && git checkout --quiet ${quote(headSha)}`, {
            inRepo: false,
          });
          if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr}`);
          await host.revokeToken(p.fork, token.id); // nothing below needs the repo
          await this.prepareToolchain(box, p, race, "verify");
          const r = await box.sh(p.check, { timeoutSeconds: 900 });
          return { green: r.exitCode === 0, log: (r.stdout + r.stderr).slice(-4000) };
        } finally {
          await box.destroy();
        }
      });

      const report: AttemptReport = {
        attemptId: p.attemptId,
        target: p.target,
        green: verdict.green,
        changedFiles,
        failureLog: verdict.green ? "" : verdict.log,
        diffSize,
        diff: exported.patch.slice(0, 60_000),
        summary: result.summary,
        rationale: result.rationale,
        problem: result.problem,
        alternatives: result.alternatives,
        headSha: headSha === baseSha ? null : headSha,
        turns: result.turns,
        usage,
      };
      await step.do("report", () => race.report(report));
    } catch (e) {
      // Report failures and halts too, so the race never waits forever.
      const halted = e instanceof Halted;
      await step.do("report-error", () =>
        race.report({
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
          usage,
        }),
      );
      await step.do("cleanup-after-error", () => agentBox.destroy());
    }
  }

  /** Toolchains (mise), then the cache (read-only here), then setup. */
  private async prepareToolchain(box: Box, p: AttemptParams, race: Race, role: "agent" | "verify") {
    const cache = parseCacheResult((await box.sh(restoreScript(p.setup), { timeoutSeconds: 300 })).stdout);
    const tools = (await box.sh(toolchainScript(), { timeoutSeconds: 600 })).stdout.trim().split("\n").at(-1) ?? "";
    if (role === "agent") {
      await race.note("cache", p.target, p.attemptId, `${cache.status === "hit" ? "warm start from the R2 cache" : "cold start"}; ${tools}`);
    }
    if (p.setup.trim()) await box.sh(p.setup, { timeoutSeconds: 900 });
  }

  private async agentLoop(p: AttemptParams, step: WorkflowStep, sandbox: Box, race: Race, usage: Usage) {
    const model = parseModel(this.env.REGATTA_AGENT_MODEL);
    const system = systemPrompt(p.check, p.setup);
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: kickoff(p.intent, p.target, p.hints) }];
    const ledger = { summary: "", rationale: "", problem: "", alternatives: "" };
    let nudged = false;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // The andon cord: honored before every turn, for this repo or the whole race.
      const halt = await step.do(`gate-${turn}`, async () => {
        const h = await race.haltedFor(p.target);
        return h ? `${h.reason} (by ${h.by})` : "";
      });
      if (halt) throw new Halted(halt);

      // Steps persist JSON strings: SDK types aren't structurally "Serializable".
      const res = JSON.parse(
        await step.do(`turn-${turn}`, { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
          const r = await modelTurn(this.env, model, system, messages);
          return JSON.stringify({ content: r.content, stop_reason: r.stop_reason, usage: r.usage });
        }),
      ) as { content: Anthropic.Beta.BetaContentBlock[]; stop_reason: string; usage?: Anthropic.Beta.BetaUsage };
      usage.inputTokens += res.usage?.input_tokens ?? 0;
      usage.outputTokens += res.usage?.output_tokens ?? 0;
      usage.cacheReadTokens += res.usage?.cache_read_input_tokens ?? 0;

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
        // No retries: tools have side effects (claims, the andon cord).
        // Errors inside a tool go back to the model as is_error results instead.
        await step.do(`tools-${turn}`, { retries: { limit: 0, delay: "1 second" } }, async () => {
          await this.requireSandbox(sandbox);
          const out: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const call of calls) out.push(await this.runTool(call, p, sandbox, race));
          return JSON.stringify(out);
        }),
      ) as Anthropic.Beta.BetaToolResultBlockParam[];
      messages.push({ role: "user", content: results });
    }
    return { ...ledger, turns: MAX_TURNS };
  }

  // Model turns replay from cached steps, but the container's checkout does
  // not survive a restart. Fail with a clear reason instead.
  private async requireSandbox(sandbox: Box) {
    if (!(await sandbox.alive())) {
      throw new Error("sandbox lost: the container restarted and its checkout is gone; rerun the attempt");
    }
  }

  private async runTool(call: Anthropic.Beta.BetaToolUseBlock, p: AttemptParams, sandbox: Box, race: Race): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
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
      case "announce": {
        const { plan, paths } = call.input as { plan: string; paths: string[] };
        const conflicts = await race.announce(p.attemptId, plan, paths);
        return done(
          conflicts.length
            ? `Announced. Heads up: another race has claimed overlapping paths in this repo:\n${conflicts
                .map((c) => `- race ${c.race} (${c.paths.join(", ")}): ${untrusted(`race ${c.race}`, c.plan)}`)
                .join("\n")}\nKeep your change narrow, or explain the overlap in your rationale.`
            : "Announced. No other race has claimed these paths.",
        );
      }
      case "write_file": {
        if (!(await race.announced(p.attemptId))) return done("Call announce with your plan and paths before changing files.", true);
        const r = await sandbox.writeFile(input.path, input.content);
        return r.exitCode === 0 ? done(`wrote ${input.path}`) : done(r.stderr, true);
      }
      case "check":
        return done(await this.check(p, sandbox, race));
      case "stop_the_line": {
        // An agent stops its own repo only; only humans stop a whole race.
        await race.halt({ by: p.attemptId, reason: input.reason, target: p.target });
        return done(`Stopped every boat on ${p.target}. A human will read your reason and decide.`);
      }
      case "ask_fleet": {
        const fixes = await race.lookup(input.error);
        return done(
          fixes.length
            ? fixes
                .map((f) => `From ${f.target} (error: ${f.signature}), reproduced green in a fresh sandbox:\n${untrusted(`fix from ${f.target}`, `${f.rationale}\n${f.diff}`)}`)
                .join("\n\n")
            : "No verified fix for this error yet.",
        );
      }
      default:
        return done(`unknown tool ${call.name}`, true);
    }
  }

  // Runs the check in the agent's own sandbox (for iteration only; it doesn't
  // decide the outcome). A pass after a failure is a *candidate* fix: it goes
  // on the blackboard only if the verify sandbox later reproduces it green.
  private async check(p: AttemptParams, sandbox: Box, race: Race) {
    const r = await sandbox.sh(p.check, { timeoutSeconds: 900 });
    const output = (r.stdout + r.stderr).slice(-6000);
    const stateFile = `${WORK}/.regatta-last-failure`;
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
        await race.candidateFix(p.attemptId, { signature: errorSignature(log), errorLog: log.slice(-1500), diff: diff.slice(0, 8000), rationale: "Fixed a failing check; see diff." });
        return `CHECK PASSED. If a fresh sandbox reproduces this, your fix will be shared with the fleet.\n${output.slice(-1500)}`;
      }
    }
    return `CHECK PASSED\n${output.slice(-1500)}`;
  }
}
