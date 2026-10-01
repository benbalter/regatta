// Installed toolchains and dependencies, cached in R2. Every package manager
// in the sandbox image writes under /cache, so one tarball covers any
// ecosystem.
//
// Untrusted code can't poison it:
// - The *namespace* (one per base repo) comes from the egress Worker's props,
//   not the request path, so a sandbox can't read or write another repo's
//   cache.
// - Only the *warm* sandbox (repo's own setup, on its base branch) may write.
//   Agent and verify sandboxes, which run agent-written code, are read-only.
// The sandbox has no internet and no credentials; it reaches the cache as a
// virtual host the egress Worker serves.

import { cacheKeyScript } from "./toolchain";

export const CACHE_HOST = "cache.regatta";
const KEY = /^\/c\/[0-9a-f]{32}\.tgz$/;

/** Only well-formed keys; the namespace is added by the egress Worker. */
export const isCacheKey = (path: string) => KEY.test(path);

/** R2 object key: the egress Worker's namespace, then the content key. */
export const cacheObjectKey = (namespace: string, path: string) => `${namespace}${path.slice(2)}`;

/** Restore /cache if this dependency set has been seen. Never fails the step. */
export function restoreScript(setup: string): string {
  return [
    cacheKeyScript(setup),
    `if curl -sf -o /tmp/cache.tgz "http://${CACHE_HOST}/c/$KEY.tgz"; then tar xzf /tmp/cache.tgz -C / && rm -f /tmp/cache.tgz && echo "hit $KEY"; else echo "miss $KEY"; fi`,
  ].join("\n");
}

/** Save /cache for this dependency set (warm sandbox only; egress refuses others). */
export function saveScript(setup: string): string {
  return [
    cacheKeyScript(setup),
    `if curl -sfI "http://${CACHE_HOST}/c/$KEY.tgz" >/dev/null; then echo "exists $KEY"; exit 0; fi`,
    `tar czf /tmp/cache.tgz /cache 2>/dev/null && curl -sf -X PUT --data-binary @/tmp/cache.tgz "http://${CACHE_HOST}/c/$KEY.tgz" >/dev/null && echo "saved $KEY" || echo "save failed $KEY"`,
    "rm -f /tmp/cache.tgz",
  ].join("\n");
}

export function parseCacheResult(stdout: string): { status: "hit" | "miss" | "saved" | "exists" | "unknown"; key: string } {
  const m = stdout.trim().split("\n").at(-1)?.match(/^(hit|miss|saved|exists|save failed) ([0-9a-f]{32})$/);
  if (!m) return { status: "unknown", key: "" };
  return { status: m[1] === "save failed" ? "unknown" : (m[1] as "hit" | "miss" | "saved" | "exists"), key: m[2] };
}
