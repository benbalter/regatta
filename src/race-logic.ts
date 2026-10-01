// Pure race decisions, testable without the Durable Object runtime.

import type { RaceView } from "./schemas";

export interface AttemptLike {
  id: string;
  target: string;
  base: string;
  state: string;
  createdAt: string;
}

// After the andon cord is released, restart each target whose most recent
// attempt was the one the halt stopped. Suffixes h1, h2, … keep ids unique.
export function relaunchAfterHalt(attempts: AttemptLike[]): Array<{ target: string; base: string; suffix: string; retryOf: string }> {
  const latest = new Map<string, AttemptLike>();
  const haltRuns = new Map<string, number>();
  for (const a of [...attempts].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    latest.set(a.target, a);
    if (/-h\d+$/.test(a.id)) haltRuns.set(a.target, (haltRuns.get(a.target) ?? 0) + 1);
  }
  return [...latest.values()]
    .filter((a) => a.state === "halted")
    .map((a) => ({ target: a.target, base: a.base, suffix: `h${(haltRuns.get(a.target) ?? 0) + 1}`, retryOf: a.id }));
}

/** What an agent needs to decide its next move, without diffs. */
export function summarize(r: RaceView) {
  const states: Record<string, number> = {};
  for (const a of r.attempts) {
    const k = a.state === "done" ? (a.report?.green ? "green" : "red") : a.state;
    states[k] = (states[k] ?? 0) + 1;
  }
  return {
    id: r.id,
    intent: r.spec.intent,
    halted: r.halt ? `${r.halt.reason} (by ${r.halt.by})` : null,
    boats: states,
    fixesShared: r.fixes.length,
    clusters: r.clusters.map((c) => ({
      key: c.key,
      label: c.label,
      verdict: c.verdict.decision,
      reasons: c.verdict.reasons,
      repos: c.targets,
      winners: c.winners,
      approved: r.approved.includes(c.key),
      decisionDoc: r.decisionDocs[c.key]
        ? {
            recommendation: r.decisionDocs[c.key].recommendation,
            ask: r.decisionDocs[c.key].ask,
            dissent: r.decisionDocs[c.key].dissent?.argument ?? null,
          }
        : null,
    })),
    recentLog: r.feed.slice(-12).map((e) => `${e.at.slice(11, 19)} ${e.kind}${e.target ? ` ${e.target}` : ""}: ${e.text}`),
  };
}

