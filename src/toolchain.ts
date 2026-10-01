import { quote as shellQuote } from "shell-quote";

// Language-agnostic sandbox setup. Nothing here knows about any one ecosystem
// beyond a data table: a repo's own version files (.tool-versions, mise.toml,
// .nvmrc, .ruby-version, .python-version, …) win, and otherwise a manifest
// implies a default runtime. mise installs precompiled toolchains, and every
// package manager is pointed at /cache (see the Dockerfile) so one cache
// tarball covers them all.
//
// These scripts run only in sandboxes that already run repo code (agent,
// verify, warm). mise reads repo config and can execute plugins, so the
// git-only sandboxes (publish, land, sync, why) never call it.

/** Manifest → runtime default, used only when the repo pins nothing itself. */
export const RUNTIME_DEFAULTS: Array<{ manifests: string[]; tool: string }> = [
  { manifests: ["package.json"], tool: "node@lts" },
  { manifests: ["Gemfile", "*.gemspec"], tool: "ruby@3.4" },
  { manifests: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], tool: "python@3.12" },
  { manifests: ["go.mod"], tool: "go@latest" },
  { manifests: ["Cargo.toml"], tool: "rust@stable" },
];

/** Files whose tracked contents decide what gets installed: the cache key. */
export const DEPENDENCY_FILES = [
  ".tool-versions", "mise.toml", ".mise.toml", ".nvmrc", ".node-version", ".ruby-version", ".python-version", "rust-toolchain.toml",
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "Gemfile", "Gemfile.lock", "*.gemspec",
  "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile.lock", "requirements*.txt", "setup.py",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
];

const shq = (s: string) => shellQuote([s]);

/** Install the repo's toolchains with mise. Never fails the step; the check will. */
export function toolchainScript(): string {
  const defaults = RUNTIME_DEFAULTS.map(
    // Patterns are our own constants and must stay unquoted so the shell globs `*.gemspec`.
    ({ manifests, tool }) => `if ls ${manifests.join(" ")} >/dev/null 2>&1; then DEFAULTS="$DEFAULTS ${tool}"; fi`,
  );
  return [
    "DEFAULTS=''",
    ...defaults,
    // A repo that pins its own versions gets exactly those.
    "if ls .tool-versions mise.toml .mise.toml .nvmrc .node-version .ruby-version .python-version rust-toolchain.toml >/dev/null 2>&1; then mise trust --quiet . 2>/dev/null; mise install --quiet 2>&1 | tail -5; fi",
    // Anything else implied by a manifest but not pinned gets the default.
    'for t in $DEFAULTS; do mise use --global --quiet "$t" 2>&1 | tail -2; done',
    "mise reshim 2>/dev/null; echo \"toolchains: $(mise ls --current 2>/dev/null | awk '{print $1\"@\"$2}' | tr '\\n' ' ')\"",
  ].join("\n");
}

/**
 * Cache key: tracked dependency files + the setup command + the image's
 * toolchain generation. Tracked only, so a lockfile the install creates
 * doesn't change the key between restore and save.
 */
export function cacheKeyScript(setup: string): string {
  return `KEY=$( (git ls-files -z -- ${DEPENDENCY_FILES.map(shq).join(" ")} | xargs -0 cat 2>/dev/null; printf %s ${shq(setup)}; echo "$REGATTA_IMAGE_GENERATION") | sha256sum | cut -c1-32 )`;
}
