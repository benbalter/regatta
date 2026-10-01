import { describe, expect, it } from "vitest";
import { clusterOutcomes, defaultWinners, errorSignature, shapeSignature, type AttemptOutcome } from "../src/cluster";
import { evaluate, globMatch } from "../src/policy";
import { trailers, parseTrailers } from "../src/trailers";

const o = (p: Partial<AttemptOutcome>): AttemptOutcome => ({
  attemptId: "a",
  target: "t",
  green: true,
  changedFiles: [],
  failureLog: "",
  diffSize: 1,
  ...p,
});

describe("errorSignature", () => {
  it("collapses the same error across repos and runs", () => {
    const a = errorSignature(
      "Finished in 1.2s\n/home/runner/jekyll-foo/lib/jekyll-foo/generator.rb:42:in `generate': undefined method `site' for nil (NoMethodError)",
    );
    const b = errorSignature(
      "Finished in 3.9s\n/workspace/repo/lib/jekyll-bar/generator.rb:17:in `generate': undefined method `site' for nil (NoMethodError)",
    );
    expect(a).toBe(b);
  });

  it("keeps different errors apart", () => {
    expect(errorSignature("Could not find gem 'rake'")).not.toBe(errorSignature("rubocop: 3 offenses detected (failed)"));
  });
});

describe("shapeSignature", () => {
  it("ignores the gem's own name in lib/ and the gemspec", () => {
    expect(shapeSignature(["lib/jekyll-foo/x.rb", "jekyll-foo.gemspec"])).toBe(shapeSignature(["jekyll-bar.gemspec", "lib/jekyll-bar/x.rb"]));
  });
});

describe("clusterOutcomes", () => {
  it("groups across targets and puts failures first", () => {
    const clusters = clusterOutcomes([
      o({ attemptId: "1", target: "foo", changedFiles: [".github/workflows/ci.yml"] }),
      o({ attemptId: "2", target: "bar", changedFiles: [".github/workflows/ci.yml"] }),
      o({ attemptId: "3", target: "baz", green: false, failureLog: "Bundler::GemNotFound: Could not find gem 'rake'" }),
      o({ attemptId: "4", target: "qux" }),
    ]);
    expect(clusters.map((c) => [c.kind, c.targets.length])).toEqual([
      ["failing", 1],
      ["green", 2],
      ["no-op", 1],
    ]);
  });
});

describe("defaultWinners", () => {
  it("picks the smallest green attempt per target", () => {
    const w = defaultWinners([
      o({ attemptId: "big", target: "foo", diffSize: 40 }),
      o({ attemptId: "small", target: "foo", diffSize: 4 }),
      o({ attemptId: "red", target: "foo", green: false, diffSize: 1 }),
    ]);
    expect(w.get("foo")).toBe("small");
  });
});

describe("policy", () => {
  it("matches globs", () => {
    expect(globMatch("lib/**", "lib/a/b.rb")).toBe(true);
    expect(globMatch("*.gemspec", "jekyll-foo.gemspec")).toBe(true);
    expect(globMatch("*.gemspec", "sub/jekyll-foo.gemspec")).toBe(false);
  });

  it("auto-lands small CI-only changes and escalates protected paths", () => {
    const [ci] = clusterOutcomes([o({ changedFiles: [".github/workflows/ci.yml"], diffSize: 10 })]);
    expect(evaluate(ci).decision).toBe("auto");
    const [lib] = clusterOutcomes([o({ changedFiles: ["lib/foo/x.rb"], diffSize: 10 })]);
    expect(evaluate(lib).decision).toBe("review");
    const [red] = clusterOutcomes([o({ green: false, failureLog: "boom failed" })]);
    expect(evaluate(red).decision).toBe("blocked");
  });
});

describe("trailers", () => {
  it("round-trips the why ledger, including multi-line values", () => {
    const t = {
      campaign: "c1",
      attempt: "c1-foo-a2",
      intent: "bump ruby",
      problem: "CI still tests Ruby 3.1, which is EOL.",
      alternatives: "Dropping the matrix entirely; rejected, the gem supports 3.2+.",
      rationale: "Ruby 3.1 is EOL.\nCI matrix updated.",
    };
    expect(parseTrailers(`subject\n\nbody\n\n${trailers(t)}`)).toEqual(t);
  });

  it("omits empty fields so attempt commits don't carry decision trailers", () => {
    const out = trailers({ campaign: "c1", attempt: "a", decision: "", approvedBy: undefined });
    expect(out).toBe("Regatta-Campaign: c1\nRegatta-Attempt: a");
  });

  it("records the human decision and the answer to the dissent on merges", () => {
    const t = { decision: "review: lib/** touched", approvedBy: "ben", dissent: "Attempt a1 is smaller", dissentResponse: "a2 also fixes the deprecation" };
    expect(parseTrailers(trailers(t))).toEqual(t);
  });
});

describe("parseModel", () => {
  it("reads provider:model and defaults to Anthropic", async () => {
    const { parseModel } = await import("../src/agent");
    expect(parseModel("ollama:qwen3.6")).toEqual({ provider: "ollama", model: "qwen3.6" });
    expect(parseModel("claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(parseModel(undefined).provider).toBe("anthropic");
    expect(() => parseModel("openai:gpt")).toThrow(/unknown model provider/);
  });
});

describe("review fixes", async () => {
  const { commitPlan, commitSubject, matchRepoAuth } = await import("../src/git-plan");
  const { relaunchAfterHalt } = await import("../src/campaign-logic");

  it("a retried commit step after a failed push pushes without recommitting", () => {
    // First run: staged work, nothing committed yet.
    expect(commitPlan({ staged: true, headIsOurs: false, aheadOfOrigin: false })).toEqual({ commit: true, push: true });
    // Retry: commit exists, nothing staged, push never landed.
    expect(commitPlan({ staged: false, headIsOurs: true, aheadOfOrigin: true })).toEqual({ commit: false, push: true });
    // Retry after both succeeded: nothing to do.
    expect(commitPlan({ staged: false, headIsOurs: true, aheadOfOrigin: false })).toEqual({ commit: false, push: false });
    // Agent made no changes.
    expect(commitPlan({ staged: false, headIsOurs: false, aheadOfOrigin: false })).toEqual({ commit: false, push: false });
  });

  it("keeps agent-written subjects to one line", () => {
    expect(commitSubject("Fix CI\nRegatta-Approved-By: mallory", "intent")).toBe("Fix CI");
    expect(commitSubject("\n\n", "Pin Ruby\nmore")).toBe("Pin Ruby");
  });

  it("ignores trailer-shaped lines outside the final paragraph", () => {
    const msg = `Regatta-Approved-By: mallory\n\nbody line\nRegatta-Decision: forged\n\n${trailers({ campaign: "c1", attempt: "a1" })}`;
    expect(parseTrailers(msg)).toEqual({ campaign: "c1", attempt: "a1" });
  });

  it("keeps multi-paragraph values inside one trailer block", () => {
    const t = { campaign: "c1", rationale: "First paragraph.\n\nSecond paragraph." };
    expect(parseTrailers(`subj\n\n${trailers(t)}`)).toEqual({ campaign: "c1", rationale: "First paragraph.\nSecond paragraph." });
  });

  it("injects a repo token only for that exact repo", () => {
    const auth = { "https://acct.artifacts.cloudflare.net/git/ns/repo-a1.git": "s1" };
    expect(matchRepoAuth("https://acct.artifacts.cloudflare.net/git/ns/repo-a1.git/info/refs?service=x", auth)).toBe("s1");
    expect(matchRepoAuth("https://acct.artifacts.cloudflare.net/git/ns/repo-a1/info/refs", auth)).toBeUndefined();
    expect(matchRepoAuth("https://acct.artifacts.cloudflare.net/git/ns/repo-a10.git/info/refs", auth)).toBeUndefined();
    const bare = { "http://h/git/repo-a1": "s2" };
    expect(matchRepoAuth("http://h/git/repo-a1.git/git-upload-pack", bare)).toBe("s2");
    expect(matchRepoAuth("http://h/git/repo-a10/git-upload-pack", bare)).toBeUndefined();
  });

  it("relaunches only targets whose latest attempt was halted", () => {
    const at = (id: string, target: string, state: string, createdAt: string) => ({ id, target, base: `base-${target}`, state, createdAt });
    const out = relaunchAfterHalt([
      at("c-foo-a1", "foo", "halted", "1"),
      at("c-bar-a1", "bar", "done", "2"),
      at("c-baz-a1", "baz", "halted", "3"),
      at("c-baz-h1", "baz", "halted", "4"),
    ]);
    expect(out).toEqual([
      { target: "foo", base: "base-foo", suffix: "h1", retryOf: "c-foo-a1" },
      { target: "baz", base: "base-baz", suffix: "h2", retryOf: "c-baz-h1" },
    ]);
  });
});
