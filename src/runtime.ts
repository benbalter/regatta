// Shared wiring for workflows: sandbox handles, egress policy, and waiting on
// Artifacts' async import/fork.

import type { WorkflowStep } from "cloudflare:workers";
import type { RepoHost, RepoRef } from "./repo-host";
import type { EgressProps } from "./sandbox";

// Package registries the check command needs. Everything else is blocked.
const ALLOW = [
  "rubygems.org",
  "index.rubygems.org",
  "rubygems.global.ssl.fastly.net",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
];

export const sandboxFor = (env: Env, id: string) => env.SANDBOX.getByName(id);

export function egressFor(env: Env, repoAuth: Record<string, string>): EgressProps {
  const rewrite: Record<string, string> = {};
  if (env.FAKE_ARTIFACTS_URL) rewrite[env.FAKE_ARTIFACTS_HOST || "artifacts.regatta.local"] = env.FAKE_ARTIFACTS_URL;
  return { allow: ALLOW, repoAuth, rewrite };
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
