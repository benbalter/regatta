# CLAUDE.md

Regatta runs one coding intent as a "race" across many repos, with competing agents ("boats") per repo that share verified fixes, then groups results into outcome clusters for review and records decisions in git trailers. It's a single Cloudflare Worker (Durable Objects, Workflows, Containers, Artifacts, Agents SDK, Workers AI, R2, Queues) with an Astro dashboard. The [README](README.md) covers the concepts, the trust model, and the architecture table; read its "Trust model" section before touching sandboxes or egress.

## Commands

There is no CI in this repo, so run these yourself before committing:

- `npm ci`, then `npm run check`: `tsc` for the Worker, `tsc -p web/tsconfig.json` for the dashboard, `vitest run`, and `redocly lint public/openapi.json`. That's the full gate.
- `npm run build:web` builds the Astro dashboard into `dist/` (gitignored). `wrangler dev` runs it automatically via `build.command` in [`wrangler.jsonc`](wrangler.jsonc).
- `npm run build:openapi` regenerates [`public/openapi.json`](public/openapi.json) from the Zod schemas in [`src/schemas.ts`](src/schemas.ts); `npm run build:client` regenerates [`src/client/schema.d.ts`](src/client/schema.d.ts) from it (`npm run build:api` does both). Run them after any schema change and commit the output, which shouldn't be edited by hand.
- `npm run types` regenerates [`worker-configuration.d.ts`](worker-configuration.d.ts) after binding changes in `wrangler.jsonc`.
- Local end to end, with no Cloudflare plan or API key: `node scripts/fake-artifacts.ts` in one terminal, `npx wrangler dev` in another, plus Docker and Ollama with `qwen3.6` and `gemma4`. [`scripts/smoke-fake.sh`](scripts/smoke-fake.sh) exercises the fake Artifacts server by itself.
- Never run `wrangler deploy` (with or without `--env production`). Production needs Workers Paid, real Artifacts, AI Gateway, and secrets, and deploying is the owner's call.

## Architecture

- [`src/index.ts`](src/index.ts): the Worker entry: HTTP API ([`src/api.ts`](src/api.ts), Hono with `@hono/zod-openapi`), MCP at `/mcp` ([`src/mcp.ts`](src/mcp.ts)), and Agents SDK WebSockets at `/agents/race/:id`.
- [`src/race.ts`](src/race.ts): the `Race` Durable Object: race state, blackboard, claims, clusters, and the feed. Pure logic is split into [`src/race-logic.ts`](src/race-logic.ts), [`src/cluster.ts`](src/cluster.ts), [`src/policy.ts`](src/policy.ts), and [`src/trailers.ts`](src/trailers.ts).
- Workflows: [`attempt`](src/attempt.ts) (agent, publish, verify), [`sync`](src/sync.ts), [`decision`](src/decision-workflow.ts), [`land`](src/land.ts).
- [`src/sandbox.ts`](src/sandbox.ts) and [`src/runtime.ts`](src/runtime.ts): one container per role per step, with outbound traffic through the egress policy in [`src/egress-policy.ts`](src/egress-policy.ts). [`src/auth.ts`](src/auth.ts): Cloudflare Access and admin-token checks for writes.
- [`web/`](web/): the Astro, React, and Kumo dashboard. [`Dockerfile`](Dockerfile): the sandbox image (mise installs each repo's toolchain).

## Testing

Tests in [`test/`](test/) run in plain Node (there's no Vitest config, so the Workers pool isn't used). They cover the pure modules (cluster, policy, trailers, auth) and the Hono app's request validation, so they can't import anything that pulls in `cloudflare:workers`. Anything that touches Durable Objects, Workflows, or containers is only checked by a local `wrangler dev` run against the fake Artifacts server.

## Gotchas

- `overrides` scopes `undici` (`^7.29.1`) and `sharp` (`^0.35.5`) to `miniflare`. The pinned `@cloudflare/vitest-pool-workers@0.22.0` holds an older miniflare, and the only security-update path Dependabot found would have downgraded the pool. Scoping to miniflare patches both copies (the pool's and wrangler's) without touching the pins, and keeps `undici` on 7.x, which miniflare requires. Recheck whether the overrides are still needed when you bump wrangler or the pool.
- Dependencies are pinned to exact versions, and `allowScripts` lists the exact `esbuild` and `workerd` versions allowed to run install scripts. Update it when a bump changes those versions.
- The local Artifacts stand-in is deliberately no friendlier than the real service: async imports and forks, expiring tokens, documented error codes, and no merge or diff API. Keep it that way so local runs stay honest.
- Treat all repo and agent text as untrusted: no credential may reach a container that runs repo or agent code, and trailers are read only from a commit's final paragraph so agents can't forge approvals.
- Secrets for local dev go in `.dev.vars` (gitignored), never in `wrangler.jsonc`.
