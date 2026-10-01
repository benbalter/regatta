import picomatch from "picomatch";
import { DEPENDENCY_FILES } from "./toolchain";
// Merge policy, modeled on a shared Renovate preset: one central rule set
// decides which clusters can land without a human, instead of each repo
// needing its own review. A cluster is the unit of approval.

import type { Cluster } from "./cluster";

export type { Policy, Verdict } from "./schemas";
import type { Policy, Verdict } from "./schemas";

// What needs a human by default, for any ecosystem: dependency manifests and
// lockfiles (supply chain), CI and build config (what runs with secrets), and
// source code. Docs, tests and config that only describe the repo can land.
export const DEFAULT_POLICY: Policy = {
  requireReviewPaths: [
    ...DEPENDENCY_FILES.flatMap((f) => [f, `**/${f}`]),
    ".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", "Dockerfile", "**/Dockerfile", "Makefile", "*.mk",
    "src/**", "lib/**", "app/**", "pkg/**", "cmd/**", "internal/**", "packages/*/src/**",
  ],
  maxAutoDiffSize: 80,
};


/** Glob match (picomatch): `**` spans directories, `*` stays within one segment. */
export const globMatch = (pattern: string, path: string) => picomatch.isMatch(path, pattern, { dot: true });

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
