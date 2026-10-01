// A race: one intent fanned out across targets × K attempts. This Durable
// Object is the single source of truth for the race, and it is also the
// agents' shared blackboard: fixes posted by one attempt are handed to every
// other attempt that hits the same failure.

import { DurableObject } from "cloudflare:workers";
import type { AttemptParams } from "./attempt";
import type { AttemptReport } from "./schemas";
import { clusterOutcomes, defaultWinners, errorSignature } from "./cluster";
import { DEFAULT_POLICY, evaluate } from "./policy";
import { repoHost } from "./repo-host";
import { relaunchAfterHalt } from "./race-logic";
import { escalateForConflicts, overlapping, undeclared } from "./claims";

// Types come from the API contract (src/schemas.ts) so spec and code can't drift.
export type { AttemptRecord, AttemptState, ClusterView, Fix, Halt, RaceSpec, RaceView, TargetSpec } from "./schemas";
import type { AttemptRecord, ClaimConflict, DecisionDoc, FeedEvent, Fix, Halt, RaceSpec, RaceView, SyncStatus, TargetSpec } from "./schemas";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
// Base repos are shared across races so each target is imported once.
export const baseName = (t: TargetSpec) => `base-${slug(t.name)}`;
const MAX_RETRIES_PER_TARGET = 2;

async function shortHash(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isSettled = (attempts: AttemptRecord[]) => !attempts.some((a) => a.state === "running");

export class Race extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS races (id TEXT PRIMARY KEY, intent TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS whys (k TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (cluster TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (attempt TEXT PRIMARY KEY, base TEXT NOT NULL, race TEXT NOT NULL, json TEXT NOT NULL, active INTEGER NOT NULL);
    `);
  }

  // --- index (only used on the instance named "_index") -------------------

  async register(id: string, intent: string): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO races VALUES (?, ?, ?)", id, intent, new Date().toISOString());
  }

  async list(): Promise<Array<{ id: string; intent: string; createdAt: string }>> {
    return this.sql
      .exec<{ id: string; intent: string; created_at: string }>("SELECT * FROM races ORDER BY created_at DESC")
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

  // --- the claim ledger (index instance) ------------------------------------
  // Announcements from every race, keyed by repo, so two races working the same
  // files in the same repo find out before review instead of at merge time.

  async claim(c: { base: string; race: string; attempt: string; paths: string[]; plan: string }): Promise<ClaimConflict[]> {
    this.sql.exec("INSERT OR REPLACE INTO claims VALUES (?, ?, ?, ?, 1)", c.attempt, c.base, c.race, JSON.stringify(c));
    return this.conflicts(c.base, c.race, c.paths);
  }

  async conflicts(base: string, race: string, paths: string[]): Promise<ClaimConflict[]> {
    const rows = this.sql
      // active = 1: announced and still in play; active = 2: already landed.
      .exec<{ json: string; active: number }>("SELECT json, active FROM claims WHERE base = ? AND race != ? AND active > 0", base, race)
      .toArray()
      .map((r) => ({ ...(JSON.parse(r.json) as { race: string; attempt: string; paths: string[]; plan: string }), landed: r.active === 2 }));
    return rows
      .map((o) => ({ race: o.race, attempt: o.attempt, paths: overlapping(paths, o.paths), theirs: o.paths, plan: o.plan, landed: o.landed }))
      .filter((o) => o.paths.length);
  }

  async releaseClaim(attempt: string): Promise<void> {
    this.sql.exec("UPDATE claims SET active = 0 WHERE attempt = ?", attempt);
  }

  // Landed work stays visible to other races: their overlapping change now
  // meets code that's already in the repo, which is more reason to look, not less.
  async landClaim(attempt: string): Promise<void> {
    this.sql.exec("UPDATE claims SET active = 2 WHERE attempt = ?", attempt);
  }

  // --- race lifecycle ---------------------------------------------------

  async start(id: string, spec: RaceSpec): Promise<void> {
    if (this.meta("spec")) throw new Error("race already started");
    this.setMeta("id", id);
    this.setMeta("spec", JSON.stringify(spec));
    this.setMeta("createdAt", new Date().toISOString());
    this.setMeta("approved", "[]");

    const host = repoHost(this.env);
    for (const t of spec.targets) {
      const base = baseName(t);
      const fresh = (await host.info(base)).status === "missing";
      if (fresh) await host.importRepo(base, t.url, t.branch);
      this.setSync(t.name, { status: "syncing", detail: "" });
      await this.env.SYNC.create({
        id: `${id}-sync-${slug(t.name)}`,
        params: { raceId: id, target: t.name, base, url: t.url, branch: t.branch, fresh },
      });
    }
  }

  /** A repo's base is current (or isn't); start its attempts only if it is. */
  async synced(target: string, status: SyncStatus, detail: string): Promise<void> {
    this.setSync(target, { status, detail });
    this.event("sync", `${status}${detail ? `: ${detail.split("\n")[0]}` : ""}`, { target });
    if (status === "conflict" || status === "failed" || this.halted()) return;
    const t = this.spec().targets.find((x) => x.name === target);
    if (!t) return;
    for (let n = 1; n <= this.spec().k; n++) await this.launch(t.name, baseName(t), `a${n}`, null, []);
  }

  private setSync(target: string, v: { status: SyncStatus | "syncing"; detail: string }) {
    const all = JSON.parse(this.meta("sync") ?? "{}");
    all[target] = v;
    this.setMeta("sync", JSON.stringify(all));
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
      announcement: null,
      undeclared: [],
      landedSha: null,
      landError: null,
      createdAt: new Date().toISOString(),
    };
    this.save(rec);
    this.event(retryOf ? "retry" : "launch", retryOf ? `relaunched after ${retryOf}${hints.length ? `, seeded with ${hints.length} fix(es) from the blackboard` : ""}` : "agent launched", { target, attempt: attemptId });
    const params: AttemptParams = { raceId: id, attemptId, target, base, fork: rec.fork, intent: spec.intent, check: spec.check, hints };
    await this.env.ATTEMPT.create({ id: attemptId, params });
  }

  async report(r: AttemptReport): Promise<void> {
    const rec = this.attempt(r.attemptId);
    if (!rec) return;
    rec.report = r;
    rec.state = r.halted ? "halted" : "done";
    rec.undeclared = rec.announcement ? undeclared(r.changedFiles, rec.announcement.paths) : r.changedFiles;
    this.save(rec);
    const outcome = r.halted ? "halted" : r.green ? `green, ${r.changedFiles.length} file(s) changed in ${r.turns} turns` : `red: ${errorSignature(r.failureLog)}`;
    this.event("finish", outcome + (rec.undeclared.length ? ` (undeclared: ${rec.undeclared.join(", ")})` : ""), { target: r.target, attempt: r.attemptId });
    // Only green work still needs its claim, until it lands.
    if (!r.green) await this.index().releaseClaim(r.attemptId);
    await this.maybeWriteDecisionDocs();
    if (!r.green && !r.error) await this.retryWithFixes(errorSignature(r.failureLog));
  }

  // --- decision docs ------------------------------------------------------------
  // Once nothing is running, write docs for clusters escalated to review. The
  // workflow id is keyed on what's being decided, so a settled race with the
  // same attempts doesn't pay for the same docs twice.

  private async maybeWriteDecisionDocs(force = false): Promise<void> {
    const attempts = this.attempts();
    if (this.halted() || !isSettled(attempts)) return;
    const basis = attempts.map((a) => a.id).sort().join(",");
    const key = `${this.meta("id")}-docs-${await shortHash(basis)}${force ? `-${Date.now().toString(36)}` : ""}`;
    if (!force && this.meta("docsRun") === key) return;
    this.setMeta("docsRun", key);
    await this.env.DECISION.create({ id: key, params: { raceId: this.meta("id")! } });
  }

  /** Regenerate decision docs on demand (for example after changing the dissent model). */
  async writeDecisionDocs(): Promise<void> {
    if (!isSettled(this.attempts())) throw new Error("attempts are still running");
    this.sql.exec("DELETE FROM docs");
    await this.maybeWriteDecisionDocs(true);
  }

  async storeDecision(doc: DecisionDoc): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO docs VALUES (?, ?)", doc.clusterKey, JSON.stringify(doc));
    this.event("decision", `decision doc ready for "${doc.clusterKey.replace(/^\w+:/, "")}"${doc.dissent ? " (with a dissent to answer)" : ""}`, {});
  }

  private docs(): Record<string, DecisionDoc> {
    return Object.fromEntries(
      this.sql.exec<{ cluster: string; json: string }>("SELECT cluster, json FROM docs").toArray().map((r) => [r.cluster, JSON.parse(r.json)]),
    );
  }

  // --- work loudly ----------------------------------------------------------

  /** An agent's plan, before its first edit. Returns overlapping claims from other races. */
  async announce(attemptId: string, plan: string, paths: string[]): Promise<ClaimConflict[]> {
    const rec = this.attempt(attemptId);
    if (!rec) throw new Error(`unknown attempt ${attemptId}`);
    rec.announcement = { plan, paths, at: new Date().toISOString() };
    this.save(rec);
    this.event("announce", `${plan} [${paths.join(", ")}]`, { target: rec.target, attempt: attemptId });
    const conflicts = await this.index().claim({ base: rec.base, race: this.meta("id")!, attempt: attemptId, paths, plan });
    const raceId = this.meta("id")!;
    for (const c of conflicts) {
      this.event("conflict", `overlaps race ${c.race} on ${c.paths.join(", ")}: "${c.plan}"`, { target: rec.target, attempt: attemptId });
      // Tell the other race too, so neither side learns about it only at merge time.
      await this.env.RACE.getByName(c.race).noteConflict(c.attempt, rec.target, `race ${raceId} announced overlapping work on ${c.paths.join(", ")}: "${plan}"`);
    }
    return conflicts;
  }

  async noteConflict(attemptId: string, target: string, text: string): Promise<void> {
    this.event("conflict", text, { target, attempt: attemptId });
  }

  async announced(attemptId: string): Promise<boolean> {
    return Boolean(this.attempt(attemptId)?.announcement);
  }

  // --- the andon cord ---------------------------------------------------------
  // Any agent or human can stop the line. Running attempts halt at their next
  // step, nothing new launches, nothing lands, and the reason is on record.

  async halt(h: Omit<Halt, "at">): Promise<void> {
    if (this.halted()) return;
    this.setMeta("halt", JSON.stringify({ ...h, at: new Date().toISOString() }));
    this.event("halt", `${h.by} stopped the line: ${h.reason}`, {});
    this.logHalt({ ...h, at: new Date().toISOString() }, "halt");
  }

  async resume(by: string): Promise<string[]> {
    const h = this.halted();
    if (!h) return [];
    this.sql.exec("DELETE FROM meta WHERE k = 'halt'");
    this.logHalt({ by, reason: `resumed after: ${h.reason}`, at: new Date().toISOString() }, "resume");
    this.event("resume", `${by} released the line`, {});
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
    this.event("fix", `posted a fix for "${f.signature}" to the blackboard`, { target: f.target, attempt: f.attemptId });
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

  async view(): Promise<RaceView | null> {
    if (!this.meta("spec")) return null;
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
    const raceId = this.meta("id")!;
    const clusters = await Promise.all(
      clusterOutcomes(outcomes).map(async (c) => {
        const chosen = Object.fromEntries(c.targets.filter((t) => c.attempts.some((a) => a.attemptId === winners.get(t))).map((t) => [t, winners.get(t)!]));
        const conflicts: Record<string, ClaimConflict[]> = {};
        for (const [target, attemptId] of Object.entries(chosen)) {
          const rec = attempts.find((a) => a.id === attemptId);
          const paths = rec?.announcement?.paths ?? rec?.report?.changedFiles ?? [];
          const found = rec && paths.length ? await this.index().conflicts(rec.base, raceId, paths) : [];
          if (found.length) conflicts[target] = found;
        }
        return { ...c, verdict: escalateForConflicts(evaluate(c, policy), conflicts), winners: chosen, conflicts };
      }),
    );
    return {
      id: this.meta("id")!,
      spec: this.spec(),
      createdAt: this.meta("createdAt")!,
      attempts,
      clusters,
      fixes: this.fixes(),
      approved: JSON.parse(this.meta("approved") ?? "[]"),
      halt: this.halted(),
      feed: this.feed(),
      decisionDocs: this.docs(),
      sync: JSON.parse(this.meta("sync") ?? "{}"),
    };
  }

  /** Approve one cluster: land each target's chosen attempt. */
  async approve(
    clusterKey: string,
    opts: { overrides?: Record<string, string>; approvedBy: string; dissentResponse?: string },
  ): Promise<string[]> {
    const overrides = opts.overrides ?? {};
    // The dissent comes from the stored doc, never the client, and has to be answered.
    const dissent = this.docs()[clusterKey]?.dissent?.argument;
    if (dissent && !opts.dissentResponse?.trim()) throw new Error("answer the dissent before approving: dissentResponse is required");
    const v = await this.view();
    if (!v) throw new Error("no such race");
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
          raceId: v.id,
          attemptId,
          target,
          base: rec.base,
          fork: rec.fork,
          clusterLabel: cluster.label,
          decision: `${cluster.verdict.decision}: ${cluster.verdict.reasons.join("; ")}`,
          approvedBy: opts.approvedBy,
          dissent,
          dissentResponse: opts.dissentResponse?.trim(),
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
    this.event("land", sha ? `landed ${sha.slice(0, 8)}` : `landing failed: ${error}`, { target: rec.target, attempt: attemptId });
    if (sha) await this.index().landClaim(attemptId);
    else await this.index().releaseClaim(attemptId);
  }

  // --- storage helpers ------------------------------------------------------

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", k, v);
  }
  private spec(): RaceSpec {
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
  private index() {
    return this.env.RACE.getByName("_index");
  }

  private event(kind: FeedEvent["kind"], text: string, where: { target?: string; attempt?: string }) {
    const e = { at: new Date().toISOString(), kind, target: where.target ?? null, attempt: where.attempt ?? null, text: text.slice(0, 500) };
    this.sql.exec("INSERT INTO feed (json) VALUES (?)", JSON.stringify(e));
  }

  private feed(): FeedEvent[] {
    return this.sql
      .exec<{ id: number; json: string }>("SELECT id, json FROM (SELECT id, json FROM feed ORDER BY id DESC LIMIT 300) ORDER BY id")
      .toArray()
      .map((r) => ({ id: r.id, ...JSON.parse(r.json) }));
  }

  private fixes(): Fix[] {
    return this.sql.exec<{ id: number; json: string }>("SELECT id, json FROM fixes ORDER BY id").toArray().map((r) => ({ id: r.id, ...JSON.parse(r.json) }));
  }
}
