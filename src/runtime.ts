// Sandbox roles and their egress policies: the trust model in one place.
//
//   role     runs repo/agent code?  repo credentials      dependency cache
//   agent    yes (untrusted)        read the fork          read
//   publish  no (git only)          write the fork         none
//   verify   yes (untrusted)        read the fork          read
//   warm     yes (repo's own)       read the base          read + write
//   sync     no (git only)          write the base         none (reads its upstream only)
//   land     no (git only)          write base, read fork  none
//   why      no (git only)          read the base          none
//
// A write token never exists in a container that runs untrusted code, and
// every role that runs untrusted code is a fresh container per step.

import type { WorkflowStep } from "cloudflare:workers";
import type { RepoHost, RepoRef } from "./repo-host";
import type { EgressProps } from "./sandbox";

export type Role = "agent" | "publish" | "verify" | "warm" | "sync" | "land" | "why";

// Read-only package registries and toolchain downloads, across ecosystems.
// Nothing here is specific to any one language; see src/egress-policy.ts for
// the read-only rule.
const REGISTRIES = [
  // npm, yarn, pnpm
  "registry.npmjs.org", "registry.yarnpkg.com",
  // PyPI
  "pypi.org", "files.pythonhosted.org",
  // RubyGems
  "rubygems.org", "index.rubygems.org", "rubygems.global.ssl.fastly.net",
  // Go modules
  "proxy.golang.org", "sum.golang.org", "storage.googleapis.com",
  // crates.io
  "crates.io", "index.crates.io", "static.crates.io",
  // Maven
  "repo.maven.apache.org", "repo1.maven.org",
  // git-sourced dependencies (fetch only)
  "github.com", "codeload.github.com",
];
const TOOLCHAINS = [
  // mise version lists and precompiled toolchains
  "mise.jdx.dev", "mise-versions.jdx.dev", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
  "nodejs.org", "dl.google.com", "go.dev", "static.rust-lang.org",
  // Sigstore's root of trust, so mise can verify toolchain attestations (verification stays on)
  "tuf-repo-cdn.sigstore.dev",
];
const READ_ONLY_INTERNET = [...REGISTRIES, ...TOOLCHAINS];

export const sandboxFor = (env: Env, id: string) => env.SANDBOX.getByName(id);

/** A sandbox id per (attempt, role), so roles never share a container. */
export const sandboxId = (owner: string, role: Role) => `${owner}--${role}`;

export function egressFor(
  env: Env,
  role: Role,
  opts: { repoAuth?: Record<string, string>; cacheNamespace?: string; upstream?: string } = {},
): EgressProps {
  const rewrite: Record<string, string> = {};
  if (env.FAKE_ARTIFACTS_URL) rewrite[env.FAKE_ARTIFACTS_HOST || "artifacts.regatta.local"] = env.FAKE_ARTIFACTS_URL;
  const runsCode = role === "agent" || role === "verify" || role === "warm";
  return {
    // Git-only roles get no internet beyond their own repo remotes, except
    // sync, which may read (fetch) from the one upstream it mirrors.
    allow: runsCode ? READ_ONLY_INTERNET : role === "sync" && opts.upstream ? [new URL(opts.upstream).hostname] : [],
    repoAuth: opts.repoAuth ?? {},
    rewrite,
    cache: runsCode && opts.cacheNamespace ? { namespace: opts.cacheNamespace, write: role === "warm" } : null,
  };
}

export async function waitReady(step: WorkflowStep, host: RepoHost, name: string, label: string): Promise<RepoRef> {
  for (let i = 0; i < 60; i++) {
    const info = await step.do(`${label}-status-${i}`, () => host.info(name));
    if (info.status === "ready") return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch };
    if (info.status === "missing") throw new Error(`${name} does not exist`);
    await step.sleep(`${label}-wait-${i}`, i < 5 ? "2 seconds" : "10 seconds");
  }
  throw new Error(`${name} never became ready`);
}
