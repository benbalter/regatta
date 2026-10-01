// Humans are an escalation path. When a cluster needs one, they get a
// one-page decision doc instead of a pile of diffs: the problem, each
// competing fork as an option, a recommendation, and the ask. A second model
// from a different family then argues against the recommendation, and the
// approver has to answer that dissent before anything lands.
//
// Prompt building and parsing are pure so they can be tested; the model calls
// live in the DecisionWorkflow.

import { z } from "@hono/zod-openapi";
import type { AttemptRecord, ClusterView } from "./schemas";

export const DocBody = z.object({
  problem: z.string(),
  options: z.array(z.object({ attempt: z.string(), target: z.string(), summary: z.string(), tradeoffs: z.string() })),
  recommendation: z.string(),
  ask: z.string(),
});
export const DissentBody = z.object({ argument: z.string(), strongestAlternative: z.string() });
export type DocBody = z.infer<typeof DocBody>;
export type DissentBody = z.infer<typeof DissentBody>;

/** Identifies what a doc was written about, so new attempts make it stale. */
export const basisOf = (c: ClusterView) => c.attempts.map((a) => a.attemptId).sort().join(",");

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

export function docPrompt(intent: string, cluster: ClusterView, attempts: AttemptRecord[]): { system: string; user: string } {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const forks = cluster.attempts.map((o) => {
    const a = byId.get(o.attemptId);
    const r = a?.report;
    return [
      `### ${o.attemptId} (repo: ${o.target}${cluster.winners[o.target] === o.attemptId ? ", current default winner" : ""})`,
      `green: ${o.green}; lines changed: ${o.diffSize}; files: ${o.changedFiles.join(", ") || "none"}`,
      a?.announcement ? `announced plan: ${a.announcement.plan}` : "announced plan: (none)",
      a?.undeclared.length ? `changed without announcing: ${a.undeclared.join(", ")}` : "",
      r ? `problem: ${r.problem}\nalternatives considered: ${r.alternatives}\nrationale: ${r.rationale}` : "",
      o.green ? `diff:\n${clip(r?.diff ?? "", 3000)}` : `failure:\n${clip(o.failureLog, 1500)}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const conflicts = Object.entries(cluster.conflicts).flatMap(([t, cs]) => cs.map((c) => `${t}: race ${c.race} also claims ${c.paths.join(", ")} ("${c.plan}")`));
  return {
    system: [
      "You write one-page decision docs for an engineer who reviews a whole cluster of agent changes at once instead of one pull request per repository.",
      "Be concrete and brief. Name attempts by id. Say what the reviewer is actually deciding, not what the agents did step by step.",
      'Reply with only a JSON object: {"problem": string, "options": [{"attempt": string, "target": string, "summary": string, "tradeoffs": string}], "recommendation": string, "ask": string}.',
    ].join("\n"),
    user: [
      `Intent for every repository: ${intent}`,
      `Cluster: ${cluster.label} (${cluster.targets.length} repositories)`,
      `Why this needs a human: ${cluster.verdict.reasons.join("; ")}`,
      conflicts.length ? `Overlapping work from other races:\n${conflicts.join("\n")}` : "",
      "Competing attempts:",
      ...forks,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function dissentPrompt(doc: DocBody, cluster: ClusterView): { system: string; user: string } {
  return {
    system: [
      "You are the dissenting reviewer. Your whole job is to argue against the recommendation below, as strongly as the evidence allows.",
      "Find the most serious real risk, missing alternative or weak assumption. Do not invent facts beyond what is given. If the recommendation is sound, argue the strongest remaining risk anyway.",
      'Reply with only a JSON object: {"argument": string, "strongestAlternative": string}.',
    ].join("\n"),
    user: [
      `Cluster: ${cluster.label}`,
      `Problem: ${doc.problem}`,
      "Options:",
      ...doc.options.map((o) => `- ${o.attempt} (${o.target}): ${o.summary}. Tradeoffs: ${o.tradeoffs}`),
      `Recommendation: ${doc.recommendation}`,
    ].join("\n"),
  };
}

// Models wrap JSON in prose or code fences often enough that we take the
// outermost object and validate it, rather than trusting the whole reply.
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Clusters escalated to a human that don't have a doc for their current attempts. */
export function needsDoc(clusters: ClusterView[], docs: Record<string, { basis: string }>): ClusterView[] {
  return clusters.filter((c) => c.verdict.decision === "review" && docs[c.key]?.basis !== basisOf(c));
}
