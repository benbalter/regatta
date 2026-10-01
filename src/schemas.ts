/**
 * Regatta's API contract: the single source of truth.
 *
 * These Zod schemas generate the OpenAPI spec, validate every request, and
 * (via z.infer) are the TypeScript types the rest of the code uses, so the
 * spec, the validation and the implementation can't drift apart. Kept free of
 * Workers-only imports so `scripts/build-openapi.ts` can run in Node.
 */
import { z } from "@hono/zod-openapi";

export const ApiError = z.object({ error: z.string() }).openapi("Error");

export const Policy = z
  .object({
    requireReviewPaths: z.array(z.string()).describe("Globs that always need a human, e.g. `lib/**`"),
    maxAutoDiffSize: z.number().int().min(0).describe("Larger diffs (lines changed per attempt) need a human"),
  })
  .openapi("Policy");

export const Target = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).describe("Display name, e.g. `jekyll-titles-from-headings`"),
    url: z.string().url().startsWith("https://").describe("Public HTTPS git URL to import from"),
    branch: z.string().optional(),
  })
  .openapi("Target");

export const RaceSpec = z
  .object({
    intent: z.string().trim().min(1).max(4000).describe("What every agent should accomplish in each repo"),
    targets: z.array(Target).min(1).max(50),
    k: z.number().int().min(1).max(3).default(2).describe("Competing agent forks per repo"),
    check: z.string().trim().min(1).max(1000).describe("Shell command that defines passing, e.g. `bundle exec rake`"),
    policy: Policy.optional(),
  })
  .openapi("RaceSpec");

export const Halt = z
  .object({ by: z.string(), reason: z.string(), at: z.string().datetime() })
  .openapi("Halt", { description: "The andon cord: who stopped the line, and why." });

export const AttemptReport = z
  .object({
    attemptId: z.string(),
    target: z.string(),
    green: z.boolean(),
    changedFiles: z.array(z.string()),
    failureLog: z.string(),
    diffSize: z.number().int(),
    diff: z.string(),
    summary: z.string(),
    rationale: z.string(),
    problem: z.string(),
    alternatives: z.string(),
    headSha: z.string().nullable(),
    turns: z.number().int(),
    error: z.string().optional(),
    halted: z.boolean().optional().describe("Stopped because the andon cord was pulled"),
  })
  .openapi("AttemptReport");

export const Announcement = z
  .object({
    plan: z.string().describe("What the agent intends to do in this repo, before it does it"),
    paths: z.array(z.string()).describe("Files, directories or globs it expects to touch"),
    at: z.string(),
  })
  .openapi("Announcement", { description: "Work loudly: an agent's plan, posted before its first edit." });

export const ClaimConflict = z
  .object({
    race: z.string(),
    attempt: z.string(),
    paths: z.array(z.string()).describe("This attempt's claims that overlap the other race's"),
    theirs: z.array(z.string()),
    plan: z.string(),
    landed: z.boolean().describe("The other race already landed this work"),
  })
  .openapi("ClaimConflict", { description: "Another race has announced overlapping work in the same repo." });

export const AttemptState = z.enum(["running", "done", "halted", "landing", "landed", "land-failed"]);

export const Attempt = z
  .object({
    id: z.string(),
    target: z.string(),
    base: z.string(),
    fork: z.string(),
    state: AttemptState,
    retryOf: z.string().nullable().describe("Set when this attempt is a coordinated retry or a relaunch"),
    hints: z.array(z.string()).describe("Fixes from other agents this attempt was seeded with"),
    report: AttemptReport.nullable(),
    announcement: Announcement.nullable(),
    undeclared: z.array(z.string()).describe("Changed files the announcement didn't cover"),
    landedSha: z.string().nullable(),
    landError: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Attempt");

export const Fix = z
  .object({
    id: z.number().int(),
    attemptId: z.string(),
    target: z.string(),
    signature: z.string().describe("Normalized error this fix resolved"),
    errorLog: z.string(),
    diff: z.string(),
    rationale: z.string(),
    createdAt: z.string(),
  })
  .openapi("Fix", { description: "A blackboard entry: one agent's fix, offered to every agent that hits the same error." });

export const Verdict = z
  .object({ decision: z.enum(["auto", "review", "blocked"]), reasons: z.array(z.string()) })
  .openapi("Verdict");

export const AttemptOutcome = z.object({
  attemptId: z.string(),
  target: z.string(),
  green: z.boolean(),
  changedFiles: z.array(z.string()),
  failureLog: z.string(),
  diffSize: z.number().int(),
});

export const Cluster = z
  .object({
    key: z.string(),
    kind: z.enum(["green", "failing", "no-op"]),
    label: z.string(),
    attempts: z.array(AttemptOutcome),
    targets: z.array(z.string()),
    verdict: Verdict,
    winners: z.record(z.string(), z.string()).describe("Target → default winning attempt (smallest green diff)"),
    conflicts: z.record(z.string(), z.array(ClaimConflict)).describe("Target → overlapping claims from other races in that repo"),
  })
  .openapi("Cluster", { description: "Attempts that ended the same way. Humans review once per cluster, not once per repo." });

export const FeedEvent = z
  .object({
    id: z.number().int(),
    at: z.string(),
    kind: z.enum(["sync", "launch", "announce", "conflict", "fix", "retry", "finish", "halt", "resume", "decision", "land", "cache"]),
    target: z.string().nullable(),
    attempt: z.string().nullable(),
    text: z.string(),
  })
  .openapi("FeedEvent", { description: "One line in the race's live feed." });

export const DecisionDoc = z
  .object({
    clusterKey: z.string(),
    basis: z.string().describe("The attempt ids this doc was written about; new attempts make it stale"),
    problem: z.string(),
    options: z.array(z.object({ attempt: z.string(), target: z.string(), summary: z.string(), tradeoffs: z.string() })),
    recommendation: z.string(),
    ask: z.string().describe("What the reviewer is actually being asked to decide"),
    dissent: z
      .object({ argument: z.string(), strongestAlternative: z.string(), model: z.string() })
      .nullable()
      .describe("A second model's case against the recommendation. Approval must answer it."),
    model: z.string(),
    generatedAt: z.string(),
  })
  .openapi("DecisionDoc", { description: "One page for the human: the decision, not the diffs." });

export const SyncStatus = z.enum(["imported", "up-to-date", "fast-forwarded", "merged", "conflict", "failed"]);

export const RaceView = z
  .object({
    id: z.string(),
    spec: RaceSpec,
    createdAt: z.string(),
    attempts: z.array(Attempt),
    clusters: z.array(Cluster),
    fixes: z.array(Fix),
    approved: z.array(z.string()),
    halt: Halt.nullable(),
    feed: z.array(FeedEvent).describe("Newest last; the most recent 300"),
    decisionDocs: z.record(z.string(), DecisionDoc).describe("Cluster key → decision doc, for clusters escalated to review"),
    sync: z.record(z.string(), z.object({ status: z.union([SyncStatus, z.literal("syncing")]), detail: z.string() })),
  })
  .openapi("Race");

export const RaceSummary = z.object({ id: z.string(), intent: z.string(), createdAt: z.string() }).openapi("RaceSummary");

export const ApproveRequest = z
  .object({
    key: z.string().describe("Cluster key from the race view"),
    overrides: z.record(z.string(), z.string()).optional().describe("Target → attempt id, to pick a different fork than the default winner"),
    approvedBy: z.string().optional(),
    dissentResponse: z
      .string()
      .optional()
      .describe("Required when the cluster's decision doc has a dissent: your answer to it, saved on each landing merge"),
  })
  .openapi("ApproveRequest");

export const HaltRequest = z.object({ reason: z.string().trim().min(1), by: z.string().optional() }).openapi("HaltRequest");
export const ResumeRequest = z.object({ by: z.string().optional() }).openapi("ResumeRequest");

const TrailerFields = z.object({
  race: z.string(),
  attempt: z.string(),
  intent: z.string(),
  problem: z.string(),
  alternatives: z.string(),
  rationale: z.string(),
  decision: z.string(),
  approvedBy: z.string(),
  dissent: z.string(),
  dissentResponse: z.string(),
}).partial();

export const WhyAnswer = z
  .object({
    repo: z.string(),
    path: z.string(),
    line: z.number().int(),
    text: z.string(),
    commit: z.object({ sha: z.string(), author: z.string(), date: z.string(), subject: z.string(), trailers: TrailerFields }),
    landing: z.object({ sha: z.string(), subject: z.string(), trailers: TrailerFields }).nullable(),
  })
  .openapi("WhyAnswer", { description: "Why a line exists: the agent's reasoning, and the human or policy decision that landed it." });

export type RaceSpec = z.infer<typeof RaceSpec>;
export type TargetSpec = z.infer<typeof Target>;
export type Policy = z.infer<typeof Policy>;
export type Halt = z.infer<typeof Halt>;
export type AttemptReport = z.infer<typeof AttemptReport>;
export type AttemptState = z.infer<typeof AttemptState>;
export type AttemptRecord = z.infer<typeof Attempt>;
export type Fix = z.infer<typeof Fix>;
export type Verdict = z.infer<typeof Verdict>;
export type ClusterView = z.infer<typeof Cluster>;
export type SyncStatus = z.infer<typeof SyncStatus>;
export type RaceView = z.infer<typeof RaceView>;
export type WhyAnswer = z.infer<typeof WhyAnswer>;
export type Announcement = z.infer<typeof Announcement>;
export type ClaimConflict = z.infer<typeof ClaimConflict>;
export type FeedEvent = z.infer<typeof FeedEvent>;
export type DecisionDoc = z.infer<typeof DecisionDoc>;

/**
 * What dashboards receive over WebSocket (Agents SDK state sync). Small on
 * purpose: a version that bumps on every change plus the feed tail; clients
 * refetch the full race over HTTP when the version moves.
 */
export interface RaceLiveState {
  version: number;
  updatedAt: string | null;
  feed: FeedEvent[];
}
