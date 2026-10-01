// "Work loudly": before an agent edits a repo it announces the paths it will
// touch. Claims are glob-ish path patterns; these pure helpers decide when two
// claims could collide and which actual changes an agent never announced.

import { globMatch } from "./policy";
import type { ClaimConflict, Verdict } from "./schemas";

const norm = (p: string) => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

// A claim covers a path when it names it, a directory above it, or a glob that matches it.
export function covers(claim: string, path: string): boolean {
  const c = norm(claim);
  const p = norm(path);
  if (!c) return false;
  if (c === "." || c === "**") return true;
  if (c.includes("*")) return globMatch(c, p);
  return p === c || p.startsWith(`${c}/`);
}

const isGlob = (s: string) => s.includes("*");

// The fixed part of a claim: the claim itself, or for a glob, the directory before its first wildcard.
function stem(claim: string): string {
  const c = norm(claim);
  if (!isGlob(c)) return c;
  const before = c.split("*")[0];
  return norm(before.slice(0, before.lastIndexOf("/") + 1)) || ".";
}

// Two claims overlap when either covers the other's fixed part, or, when a
// glob is involved, their fixed parts nest. This errs toward flagging: a false
// "possible conflict" costs a glance; a miss costs a merge conflict.
export function claimsOverlap(a: string, b: string): boolean {
  if (covers(a, stem(b)) || covers(b, stem(a))) return true;
  // A root stem (from e.g. `*.gemspec`) would nest with everything, so it only
  // overlaps through the direct check above, where `*` stays within one directory.
  const [sa, sb] = [stem(a), stem(b)];
  if (sa === "." || sb === ".") return false;
  return (isGlob(a) || isGlob(b)) && (covers(sa, sb) || covers(sb, sa));
}

export function overlapping(mine: string[], theirs: string[]): string[] {
  return mine.filter((m) => theirs.some((t) => claimsOverlap(m, t)));
}

/** Files an attempt changed that its announcement didn't cover. */
export function undeclared(changed: string[], announced: string[]): string[] {
  return changed.filter((f) => !announced.some((a) => covers(a, f)));
}

// Humans are an escalation path, and overlapping work from another race is
// exactly when one is needed: policy may say "auto", but a claim conflict
// turns it into "review". A blocked cluster stays blocked.
export function escalateForConflicts(v: Verdict, conflicts: Record<string, ClaimConflict[]>): Verdict {
  const lines = Object.entries(conflicts).flatMap(([target, cs]) => cs.map((c) => `${target}: race ${c.race} also claims ${c.paths.join(", ")}`));
  if (!lines.length || v.decision === "blocked") return v;
  return { decision: "review", reasons: [...(v.decision === "review" ? v.reasons : []), ...lines] };
}
