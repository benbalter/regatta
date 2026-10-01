// A campaign: one intent fanned out across targets × K attempts. This Durable
// Object is the single source of truth for the campaign, and it is also the
// agents' shared blackboard: fixes posted by one attempt are handed to every
// other attempt that hits the same failure.

import { DurableObject } from "cloudflare:workers";
import type { AttemptParams, AttemptReport } from "./attempt";
import { clusterOutcomes, defaultWinners, errorSignature, type Cluster } from "./cluster";
import { DEFAULT_POLICY, evaluate, type Policy, type Verdict } from "./policy";
import { repoHost } from "./repo-host";
import { relaunchAfterHalt } from "./campaign-logic";

export interface TargetSpec {
  /** Display name, e.g. "jekyll-titles-from-headings". */
  name: string;
  /** Public HTTPS git URL to import from. */
  url: string;
  branch?: string;
}

export interface CampaignSpec {
  intent: string;
  targets: TargetSpec[];
  k: number;
  check: string;
  policy?: Policy;
}

export type AttemptState = "running" | "done" | "halted" | "landing" | "landed" | "land-failed";

export interface Halt {
  by: string;
  reason: string;
  at: string;
}

export interface AttemptRecord {
  id: string;
  target: string;
  base: string;
  fork: string;
  state: AttemptState;
  /** Set when this attempt is a coordinated retry of another. */
  retryOf: string | null;
  hints: string[];
  report: AttemptReport | null;
  landedSha: string | null;
  landError: string | null;
  createdAt: string;
}

export interface Fix {
  id: number;
  attemptId: string;
  target: string;
  signature: string;
  errorLog: string;
  diff: string;
  rationale: string;
  createdAt: string;
}

export interface ClusterView extends Cluster {
  verdict: Verdict;
  winners: Record<string, string>;
}

export interface CampaignView {
  id: string;
  spec: CampaignSpec;
  createdAt: string;
  attempts: AttemptRecord[];
  clusters: ClusterView[];
  fixes: Fix[];
  approved: string[];
  halt: Halt | null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
// Base repos are shared across campaigns so each target is imported once.
export const baseName = (t: TargetSpec) => `base-${slug(t.name)}`;
const MAX_RETRIES_PER_TARGET = 2;

export class Campaign extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, intent TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS whys (k TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
  }

  // --- index (only used on the instance named "_index") -------------------

  async register(id: string, intent: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO campaigns VALUES (?, ?, ?)", id, intent, new Date().toISOString());
  }

  async list(): Promise<Array<{ id: string; intent: string; createdAt: string }>> {
    return this.sql
      .exec<{ id: string; intent: string; created_at: string }>("SELECT * FROM campaigns ORDER BY created_at DESC")
      .toArray()
      .map((r) => ({ id: r.id, intent: r.intent, createdAt: r.created_at }));
  }

  /** `why` answers are immutable per commit, so cache them by repo@sha:path:line. */
  async cachedWhy(key: string): Promise<string | null> {
    return this.sql.exec<{ json: string }>("SELECT json FROM whys WHERE k = ?", key).toArray()[0]?.json ?? null;
  }

  async storeWhy(key: string, json: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO whys VALUES (?, ?)", key, json);
  }

  // --- campaign lifecycle ---------------------------------------------------

  async start(id: string, spec: CampaignSpec): Promise<void> {
    if (this.meta("spec")) throw new Error("campaign already started");
    this.setMeta("id", id);
    this.setMeta("spec", JSON.stringify(spec));
    this.setMeta("createdAt", new Date().toISOString());
    this.setMeta("approved", "[]");

    const host = repoHost(this.env);
    for (const t of spec.targets) {
      const base = baseName(t);
      if ((await host.info(base)).status === "missing") await host.importRepo(base, t.url, t.branch);
      for (let n = 1; n <= spec.k; n++) await this.launch(t.name, base, `a${n}`, null, []);
    }
  }

  private async launch(target: string, base: string, suffix: string, retryOf: string | null, hints: string[]) {
    const id = this.meta("id")!;
    const spec = this.spec();
    const attemptId = `${id}-${slug(target)}-${suffix}`;
    // Reports and fix posts can interleave while we await the Workflow
    // binding, so the same id may already be launched.
    if (this.attempt(attemptId)) return;
    const rec: AttemptRecord = {
      id: attemptId,
      target,
      base,
      fork: attemptId,
      state: "running",
      retryOf,
      hints,
      report: null,
      landedSha: null,
      landError: null,
      createdAt: new Date().toISOString(),
    };
    this.save(rec);
    const params: AttemptParams = { campaignId: id, attemptId, target, base, fork: rec.fork, intent: spec.intent, check: spec.check, hints };
    await this.env.ATTEMPT.create({ id: attemptId, params });
  }

  async report(r: AttemptReport): Promise<void> {
    const rec = this.attempt(r.attemptId);
    if (!rec) return;
    rec.report = r;
    rec.state = r.halted ? "halted" : "done";
    this.save(rec);
    if (!r.green && !r.error) await this.retryWithFixes(errorSignature(r.failureLog));
  }

  // --- the andon cord ---------------------------------------------------------
  // Any agent or human can stop the line. Running attempts halt at their next
  // step, nothing new launches, nothing lands, and the reason is on record.

  async halt(h: Omit<Halt, "at">): Promise<void> {
    if (this.halted()) return;
    this.setMeta("halt", JSON.stringify({ ...h, at: new Date().toISOString() }));
    this.logHalt({ ...h, at: new Date().toISOString() }, "halt");
  }

  async resume(by: string): Promise<string[]> {
    const h = this.halted();
    if (!h) return [];
    this.sql.exec("DELETE FROM meta WHERE k = 'halt'");
    this.logHalt({ by, reason: `resumed after: ${h.reason}`, at: new Date().toISOString() }, "resume");
    // Restarting the line restarts the work it stopped.
    const relaunched: string[] = [];
    for (const r of relaunchAfterHalt(this.attempts())) {
      await this.launch(r.target, r.base, r.suffix, r.retryOf, []);
      relaunched.push(r.target);
    }
    return relaunched;
  }

  halted(): Halt | null {
    const v = this.meta("halt");
    return v ? JSON.parse(v) : null;
  }

  private logHalt(h: Halt, kind: "halt" | "resume") {
    const log = JSON.parse(this.meta("haltLog") ?? "[]") as Array<Halt & { kind: string }>;
    this.setMeta("haltLog", JSON.stringify([...log, { ...h, kind }]));
  }

  // --- the blackboard -------------------------------------------------------

  async postFix(f: Omit<Fix, "id" | "createdAt">): Promise<void> {
    this.sql.exec("INSERT INTO fixes (json) VALUES (?)", JSON.stringify({ ...f, createdAt: new Date().toISOString() }));
    // A new fix may unblock attempts that already finished red.
    await this.retryWithFixes(f.signature);
  }

  async lookup(error: string): Promise<Fix[]> {
    const sig = errorSignature(error);
    const all = this.fixes();
    const exact = all.filter((f) => f.signature === sig);
    if (exact.length) return exact.slice(-3);
    // Fall back to fixes whose signature shares most words with the query.
    const words = new Set(sig.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    return all
      .map((f) => ({ f, score: f.signature.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.f);
  }

  // When a red attempt's failure matches a posted fix, start a fresh attempt
  // on that target seeded with the fix. That is the coordination loop: one
  // agent's solution propagates to every repo that hit the same wall.
  private async retryWithFixes(signature: string) {
    if (this.halted()) return;
    const fixes = this.fixes().filter((f) => f.signature === signature);
    if (!fixes.length) return;
    const attempts = this.attempts();
    const byTarget = new Map<string, AttemptRecord[]>();
    for (const a of attempts) byTarget.set(a.target, [...(byTarget.get(a.target) ?? []), a]);

    for (const target of byTarget.keys()) {
      // Re-read just before deciding: an earlier launch in this loop awaited
      // the Workflow binding, and another event may have changed this target.
      const list = this.attempts().filter((a) => a.target === target);
      if (list.some((a) => a.state === "running" || a.report?.green)) continue;
      const red = list.filter((a) => a.report && errorSignature(a.report.failureLog) === signature);
      if (!red.length) continue;
      const retries = list.filter((a) => a.retryOf).length;
      if (retries >= MAX_RETRIES_PER_TARGET) continue;
      const hints = fixes
        .filter((f) => f.target !== target)
        .slice(-2)
        .map((f) => `${f.target} hit "${f.signature}" and fixed it with:\n${f.diff}`);
      if (!hints.length) continue;
      await this.launch(target, red[0].base, `r${retries + 1}`, red[0].id, hints);
    }
  }

  // --- review ---------------------------------------------------------------

  async view(): Promise<CampaignView> {
    const attempts = this.attempts();
    const outcomes = attempts
      .filter((a) => a.report)
      .map((a) => ({
        attemptId: a.id,
        target: a.target,
        green: a.report!.green,
        changedFiles: a.report!.changedFiles,
        failureLog: a.report!.failureLog,
        diffSize: a.report!.diffSize,
      }));
    const winners = defaultWinners(outcomes);
    const policy = this.spec().policy ?? DEFAULT_POLICY;
    const clusters = clusterOutcomes(outcomes).map((c) => ({
      ...c,
      verdict: evaluate(c, policy),
      winners: Object.fromEntries(c.targets.filter((t) => c.attempts.some((a) => a.attemptId === winners.get(t))).map((t) => [t, winners.get(t)!])),
    }));
    return {
      id: this.meta("id")!,
      spec: this.spec(),
      createdAt: this.meta("createdAt")!,
      attempts,
      clusters,
      fixes: this.fixes(),
      approved: JSON.parse(this.meta("approved") ?? "[]"),
      halt: this.halted(),
    };
  }

  /** Approve one cluster: land each target's chosen attempt. */
  async approve(
    clusterKey: string,
    opts: { overrides?: Record<string, string>; approvedBy: string; dissent?: string; dissentResponse?: string },
  ): Promise<string[]> {
    const overrides = opts.overrides ?? {};
    const v = await this.view();
    if (v.halt) throw new Error(`line is stopped: ${v.halt.reason}`);
    const cluster = v.clusters.find((c) => c.key === clusterKey);
    if (!cluster) throw new Error("no such cluster");
    if (cluster.verdict.decision === "blocked") throw new Error("cluster is blocked by policy");
    const chosen = { ...cluster.winners, ...overrides };
    const landing: string[] = [];
    for (const [target, attemptId] of Object.entries(chosen)) {
      const rec = this.attempt(attemptId);
      if (!rec || rec.target !== target || !rec.report?.green || !rec.report.headSha) continue;
      if (rec.state === "landing" || rec.state === "landed") continue;
      rec.state = "landing";
      this.save(rec);
      await this.env.LAND.create({
        id: `land-${attemptId}`,
        params: {
          campaignId: v.id,
          attemptId,
          target,
          base: rec.base,
          fork: rec.fork,
          clusterLabel: cluster.label,
          decision: `${cluster.verdict.decision}: ${cluster.verdict.reasons.join("; ")}`,
          approvedBy: opts.approvedBy,
          dissent: opts.dissent,
          dissentResponse: opts.dissentResponse,
        },
      });
      landing.push(attemptId);
    }
    this.setMeta("approved", JSON.stringify([...new Set([...v.approved, clusterKey])]));
    return landing;
  }

  async landed(attemptId: string, sha: string | null, error: string | null): Promise<void> {
    const rec = this.attempt(attemptId);
    if (!rec) return;
    rec.state = sha ? "landed" : "land-failed";
    rec.landedSha = sha;
    rec.landError = error;
    this.save(rec);
  }

  // --- storage helpers ------------------------------------------------------

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", k, v);
  }
  private spec(): CampaignSpec {
    return JSON.parse(this.meta("spec") ?? "null");
  }
  private attempt(id: string): AttemptRecord | null {
    const row = this.sql.exec<{ json: string }>("SELECT json FROM attempts WHERE id = ?", id).toArray()[0];
    return row ? JSON.parse(row.json) : null;
  }
  private attempts(): AttemptRecord[] {
    return this.sql.exec<{ json: string }>("SELECT json FROM attempts ORDER BY json_extract(json, '$.createdAt')").toArray().map((r) => JSON.parse(r.json));
  }
  private save(rec: AttemptRecord) {
    this.sql.exec("INSERT OR REPLACE INTO attempts VALUES (?, ?)", rec.id, JSON.stringify(rec));
  }
  private fixes(): Fix[] {
    return this.sql.exec<{ id: number; json: string }>("SELECT id, json FROM fixes ORDER BY id").toArray().map((r) => ({ id: r.id, ...JSON.parse(r.json) }));
  }
}
