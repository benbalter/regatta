// Merge policy, modeled on a shared Renovate preset: one central rule set
// decides which clusters can land without a human, instead of each repo
// needing its own review. A cluster is the unit of approval.

import type { Cluster } from "./cluster";

export interface Policy {
  /** Clusters that touch any of these paths always need a human. */
  requireReviewPaths: string[];
  /** Larger changes than this (lines, per attempt) need a human. */
  maxAutoDiffSize: number;
}

export const DEFAULT_POLICY: Policy = {
  requireReviewPaths: ["*.gemspec", "lib/**", "Gemfile"],
  maxAutoDiffSize: 80,
};

export type Verdict = { decision: "auto" | "review" | "blocked"; reasons: string[] };

// Minimal glob: `**` spans directories, `*` stays within one segment.
export function globMatch(pattern: string, path: string): boolean {
  const re = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}

export function evaluate(cluster: Cluster, policy: Policy = DEFAULT_POLICY): Verdict {
  if (cluster.kind === "failing") return { decision: "blocked", reasons: ["checks failing"] };
  if (cluster.kind === "no-op") return { decision: "auto", reasons: ["nothing to land"] };
  const reasons: string[] = [];
  const files = new Set(cluster.attempts.flatMap((a) => a.changedFiles));
  for (const f of files) {
    const hit = policy.requireReviewPaths.find((p) => globMatch(p, f));
    if (hit) reasons.push(`${f} matches ${hit}`);
  }
  const biggest = Math.max(...cluster.attempts.map((a) => a.diffSize));
  if (biggest > policy.maxAutoDiffSize) reasons.push(`diff of ${biggest} lines exceeds ${policy.maxAutoDiffSize}`);
  return reasons.length ? { decision: "review", reasons } : { decision: "auto", reasons: ["green and within policy"] };
}
