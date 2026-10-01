// Pure race decisions, testable without the Durable Object runtime.

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
