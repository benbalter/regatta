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
  // Words failing tools print in most languages and test runners.
  const interesting =
    lines.find((l) => /\b(error|errors|failed|failure|failures|exception|panic|fatal|traceback|cannot|could not|not found|undefined|assert(ion)?)\b/i.test(l)) ??
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

// A repo's own name (its package directory, its manifest) shouldn't split a
// cluster: `lib/jekyll-foo/x.rb` in jekyll-foo and `lib/jekyll-bar/x.rb` in
// jekyll-bar, or `packages/foo/src/a.ts` in foo, are the same shape of change.
// Matching is on the normalized repo name, so it works for any ecosystem.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function shapeSignature(files: string[], repoName = ""): string {
  const own = norm(repoName);
  const collapse = (segment: string) => {
    const dot = segment.indexOf(".", 1);
    const stem = dot > 0 ? segment.slice(0, dot) : segment;
    return own && norm(stem) === own ? `*${dot > 0 ? segment.slice(dot) : ""}` : segment;
  };
  return [...new Set(files.map((f) => f.split("/").map(collapse).join("/")))].sort().join(",");
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
      const shape = shapeSignature(o.changedFiles, o.target);
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
