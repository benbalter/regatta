// Artifacts account-level events, delivered by a Queue. A fork finishing is
// the moment a waiting attempt can start, so the consumer wakes that attempt's
// Workflow instead of making it poll. Repo-level `pushed` events would need a
// subscription per fork, so Regatta subscribes at the account level only.

export const FORK_READY = "repo-ready";

export type ArtifactsEventRoute = { kind: "fork-ready"; attemptId: string; raceId: string } | { kind: "ignore" };

// Attempt forks are named <race>-<repo>-<a|r|h><n>; see Race.launch.
const ATTEMPT_FORK = /^(c[a-z0-9]+)-.+-[arh]\d+$/;

export function routeArtifactsEvent(body: unknown): ArtifactsEventRoute {
  const e = body as { type?: string; source?: { repoName?: string } };
  const name = e?.source?.repoName ?? "";
  const m = name.match(ATTEMPT_FORK);
  if (e?.type === "cf.artifacts.repo.forked" && m) return { kind: "fork-ready", attemptId: name, raceId: m[1] };
  return { kind: "ignore" };
}
