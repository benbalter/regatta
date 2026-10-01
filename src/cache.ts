// Installed gems cached in R2, keyed by the repo's dependency files. With
// 8 repos × K forks, a cold `bundle install` per boat dominates race time;
// a warm restore is one download. Cloudflare's build-on-push guide caches
// dependencies in R2 the same way.
//
// The sandbox has no internet and no credentials, so it reaches the cache as
// a virtual host (`cache.regatta`) that the egress Worker serves from R2.

export const CACHE_HOST = "cache.regatta";
const KEY = /^\/gems\/[0-9a-f]{32}\.tgz$/;

/** Only well-formed cache keys are readable or writable. */
export const isCacheKey = (path: string) => KEY.test(path);

// The key covers the *tracked* files that decide what bundler installs, plus
// the Ruby version (native extensions are ABI-specific). Tracked only: many
// gems don't commit Gemfile.lock, and `bundle install` creates one, so hashing
// whatever is on disk would give the restore (fresh clone) and the save (after
// install) different keys for the same dependencies. GEM_HOME in the ruby
// image is /usr/local/bundle.
const keyScript = `KEY=$( (git ls-files -z -- Gemfile Gemfile.lock '*.gemspec' | xargs -0 cat; ruby -v) | sha256sum | cut -c1-32 )`;

/** Restore installed gems if this dependency set has been seen before. Never fails the step. */
export const restoreScript = [
  keyScript,
  `if curl -sf -o /tmp/gems.tgz "http://${CACHE_HOST}/gems/$KEY.tgz"; then tar xzf /tmp/gems.tgz -C / && rm -f /tmp/gems.tgz && echo "hit $KEY"; else echo "miss $KEY"; fi`,
].join("\n");

/** Save installed gems for this dependency set, unless they're already cached. Never fails the step. */
export const saveScript = [
  keyScript,
  `if curl -sfI "http://${CACHE_HOST}/gems/$KEY.tgz" >/dev/null; then echo "exists $KEY"; exit 0; fi`,
  `tar czf /tmp/gems.tgz /usr/local/bundle 2>/dev/null && curl -sf -X PUT --data-binary @/tmp/gems.tgz "http://${CACHE_HOST}/gems/$KEY.tgz" >/dev/null && echo "saved $KEY" || echo "save failed $KEY"`,
  "rm -f /tmp/gems.tgz",
].join("\n");

export function parseCacheResult(stdout: string): { status: "hit" | "miss" | "saved" | "exists" | "unknown"; key: string } {
  const m = stdout.trim().split("\n").at(-1)?.match(/^(hit|miss|saved|exists|save failed) ([0-9a-f]{32})$/);
  if (!m) return { status: "unknown", key: "" };
  return { status: m[1] === "save failed" ? "unknown" : (m[1] as "hit" | "miss" | "saved" | "exists"), key: m[2] };
}
