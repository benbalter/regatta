// Pure decisions behind the attempt's commit step and the egress proxy, kept
// out of Workers-only modules so vitest can exercise them directly.

export interface RepoState {
  /** `git diff --cached --quiet` reported staged changes. */
  staged: boolean;
  /** HEAD already carries this attempt's `Regatta-Attempt` trailer. */
  headIsOurs: boolean;
  /** HEAD has commits the fork's remote branch doesn't. */
  aheadOfOrigin: boolean;
}

// Workflow steps retry. A retry after a successful commit but failed push must
// not mistake "nothing staged" for "no changes": skip the commit, still push.
export function commitPlan(s: RepoState): { commit: boolean; push: boolean } {
  const commit = s.staged && !s.headIsOurs;
  return { commit, push: commit || s.aheadOfOrigin };
}

// The commit subject is agent-written. Keep it to one line so it can't smuggle
// a trailer-shaped line into the message.
export function commitSubject(summary: string | undefined, fallback: string): string {
  const first = (summary ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return (first || fallback.split(/\r?\n/)[0]).slice(0, 200);
}

// Inject a repo token only for that exact repo: the remote itself, or paths
// under it. A bare prefix match would let `.../repo-a1` match `.../repo-a10`.
export function matchRepoAuth(url: string, repoAuth: Record<string, string>): string | undefined {
  const u = url.split("?")[0];
  for (const [remote, secret] of Object.entries(repoAuth)) {
    const base = remote.replace(/\/$/, "");
    const bare = base.replace(/\.git$/, "");
    for (const root of new Set([base, `${bare}.git`])) {
      if (u === root || u.startsWith(`${root}/`)) return secret;
    }
  }
  return undefined;
}

/** POSIX single-quote a shell argument. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
