// `why file:line`: git blame answers *who*; Regatta's trailers answer *why*.
// Blame finds the commit that last touched the line; the attempt commit holds
// the agent's problem/alternatives/rationale, and the merge that landed it
// holds the human or policy decision.

import { repoHost } from "./repo-host";
import { egressFor, sandboxFor } from "./runtime";
import { quote } from "./sandbox";
import { parseTrailers, type RegattaTrailers } from "./trailers";

export interface WhyAnswer {
  repo: string;
  path: string;
  line: number;
  text: string;
  commit: { sha: string; author: string; date: string; subject: string; trailers: Partial<RegattaTrailers> };
  landing: { sha: string; subject: string; trailers: Partial<RegattaTrailers> } | null;
}

const SEP = "\x1f";

export async function why(env: Env, repo: string, path: string, line: number): Promise<WhyAnswer> {
  const host = repoHost(env);
  const info = await host.info(repo);
  if (info.status !== "ready") throw new Error(`${repo} is ${info.status}`);
  // One long-lived sandbox per repo keeps a warm clone; each query just fetches.
  const sandbox = sandboxFor(env, `why-${repo}`);
  const token = await host.token(repo, "read", 600);
  try {
    await sandbox.prepare(egressFor(env, { [info.remote]: token.secret }));
    const sync = await sandbox.sh(
      `if [ -d repo/.git ]; then git -C repo fetch --quiet origin && git -C repo reset --quiet --hard FETCH_HEAD; else git clone --quiet ${quote(info.remote)} repo; fi`,
      { inRepo: false },
    );
    if (sync.exitCode !== 0) throw new Error(`sync failed: ${sync.stderr}`);

    const blame = await sandbox.sh(`git blame --porcelain -L ${line},${line} -- ${quote(path)}`);
    if (blame.exitCode !== 0) throw new Error(blame.stderr.trim() || `cannot blame ${path}:${line}`);
    const sha = blame.stdout.split(" ")[0];
    const text = blame.stdout.split("\n").find((l) => l.startsWith("\t"))?.slice(1) ?? "";

    const show = await sandbox.sh(`git show -s --format=${quote(["%H", "%an", "%aI", "%s", "%B"].join("%x1f"))} ${sha}`);
    const [full, author, date, subject, body] = show.stdout.split(SEP);

    // The first merge on the default branch that brought this commit in.
    const merge = await sandbox.sh(
      `git log --merges --ancestry-path --first-parent --reverse --format=${quote(["%H", "%s", "%B"].join("%x1f") + "%x1e")} ${sha}..HEAD | head -c 20000`,
    );
    const first = merge.stdout.split("\x1e")[0]?.trim();
    const landing = first
      ? (() => {
          const [msha, msubject, mbody] = first.split(SEP);
          return { sha: msha, subject: msubject, trailers: parseTrailers(mbody ?? "") };
        })()
      : null;

    return { repo, path, line, text, commit: { sha: full, author, date, subject, trailers: parseTrailers(body ?? "") }, landing };
  } finally {
    await host.revokeToken(repo, token.id);
  }
}
