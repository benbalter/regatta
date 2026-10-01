// Deterministic outcome clustering. The point of a race is that a human
// reviews once per *kind* of result, not once per repo, so attempts that
// failed the same way or changed the same files must land in the same bucket
// no matter which repo they ran against.

export interface AttemptOutcome {
  attemptId: string;
  target: string;
  green: boolean;
  /** Paths changed relative to the base, as reported by `git diff --name-only`. */
  changedFiles: string[];
  /** Tail of the failing check's output; empty when green. */
  failureLog: string;
  /** Lines added + removed, used to pick the smallest green attempt. */
  diffSize: number;
}

export interface Cluster {
  key: string;
  kind: "green" | "failing" | "no-op";
  label: string;
  attempts: AttemptOutcome[];
  targets: string[];
}

// Strip what varies between repos and runs (paths, line numbers, hashes,
// durations, versions) so the same underlying error yields the same signature.
export function errorSignature(log: string): string {
  const lines = log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const interesting =
    lines.find((l) => /\b(error|failed|failure|exception|cannot|could not|undefined method|uninitialized constant)\b/i.test(l)) ??
    lines.at(-1) ??
    "";
  return interesting
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(?:\/[\w.@-]+)+\/([\w.@-]+)/g, "$1") // absolute paths -> basename
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\d+(\.\d+)+/g, "<ver>")
    .replace(/:\d+(:\d+)?/g, ":<n>")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|seconds)\b/g, "<t>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

// Repo-specific names (the gem's own lib/<name>/…) shouldn't split a cluster,
// so collapse a leading lib/<x>/ or spec/<x>/ segment.
export function shapeSignature(files: string[]): string {
  return [...new Set(files.map((f) => f.replace(/^(lib|spec|test)\/[^/]+\//, "$1/*/").replace(/^[^/]+\.gemspec$/, "*.gemspec")))]
    .sort()
    .join(",");
}

export function clusterOutcomes(outcomes: AttemptOutcome[]): Cluster[] {
  const byKey = new Map<string, Cluster>();
  for (const o of outcomes) {
    let key: string;
    let kind: Cluster["kind"];
    let label: string;
    if (!o.green) {
      const sig = errorSignature(o.failureLog);
      key = `failing:${sig}`;
      kind = "failing";
      label = sig || "failed with no output";
    } else if (o.changedFiles.length === 0) {
      key = "no-op";
      kind = "no-op";
      label = "green, no changes needed";
    } else {
      const shape = shapeSignature(o.changedFiles);
      key = `green:${shape}`;
      kind = "green";
      label = `green, changed ${shape}`;
    }
    const c = byKey.get(key) ?? { key, kind, label, attempts: [], targets: [] };
    c.attempts.push(o);
    if (!c.targets.includes(o.target)) c.targets.push(o.target);
    byKey.set(key, c);
  }
  const order = { failing: 0, green: 1, "no-op": 2 } as const;
  return [...byKey.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.targets.length - a.targets.length);
}

// Best-of-K: per target, the smallest green attempt wins by default. A human
// can override, but the default should be the least surprising change.
export function defaultWinners(outcomes: AttemptOutcome[]): Map<string, string> {
  const winners = new Map<string, AttemptOutcome>();
  for (const o of outcomes) {
    if (!o.green) continue;
    const cur = winners.get(o.target);
    if (!cur || o.diffSize < cur.diffSize) winners.set(o.target, o);
  }
  return new Map([...winners].map(([t, o]) => [t, o.attemptId]));
}
