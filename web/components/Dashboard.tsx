// The Regatta dashboard: a race committee's log.
// - Live: each race page subscribes to its Race agent (Agents SDK state sync)
//   and refetches the full view when the agent's version moves.
// - Typed: every HTTP call goes through the client generated from the OpenAPI spec.
// - Kumo: Cloudflare's component library for controls; the race-committee look
//   lives in the layout and theme tokens (web/styles/global.css).
import "@cloudflare/kumo/styles/standalone";
import { Badge, Button, Empty, Input, InputArea, Loader, PoweredByCloudflare, SensitiveInput } from "@cloudflare/kumo";
import { useAgent } from "agents/react";
import { html as renderDiff } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import DOMPurify from "dompurify";
import createClient from "openapi-fetch";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { components, paths } from "../../src/client/schema";
import type { RaceLiveState } from "../../src/schemas";

type Race = components["schemas"]["Race"];
type Cluster = components["schemas"]["Cluster"];
type Attempt = components["schemas"]["Attempt"];
type DecisionDoc = components["schemas"]["DecisionDoc"];
type WhyAnswer = components["schemas"]["WhyAnswer"];
type RaceSummary = components["schemas"]["RaceSummary"];
type FeedEvent = components["schemas"]["FeedEvent"];

// ---- per-viewer conveniences (storage may be unavailable) -------------------
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode: settings just won't persist */
    }
  },
};

const api = createClient<paths>({ baseUrl: location.origin });
api.use({
  onRequest({ request }) {
    const token = store.get("regatta-admin-token");
    if (token) request.headers.set("authorization", `Bearer ${token}`);
    return request;
  },
});

// Kumo's brand token drives its primary buttons (white text on it): a deep
// navy in light mode, a signal blue in dark mode. See --brand in global.css.
const kumoTheme = { ["--color-kumo-brand" as string]: "var(--brand)" } as CSSProperties;

// ---- routing ------------------------------------------------------------------
type Route = { name: "list" } | { name: "new" } | { name: "race"; id: string };
const parseRoute = (): Route => {
  const m = location.hash.match(/^#\/races\/([^/]+)/);
  if (m) return { name: "race", id: decodeURIComponent(m[1]) };
  return location.hash === "#/new" ? { name: "new" } : { name: "list" };
};
function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

// ---- the status language: International Code of Signals flag colors ----------
const FLAG: Record<string, string> = {
  running: "bg-flag-blue",
  done: "bg-ink",
  green: "bg-flag-green",
  red: "bg-flag-red",
  halted: "bg-flag-red",
  landing: "bg-flag-yellow",
  landed: "bg-flag-green",
  "land-failed": "bg-flag-red",
  auto: "bg-flag-green",
  review: "bg-flag-yellow",
  blocked: "bg-flag-red",
  sync: "bg-muted",
  launch: "bg-flag-blue",
  retry: "bg-flag-blue",
  announce: "bg-ink",
  conflict: "bg-flag-yellow",
  fix: "bg-flag-green",
  finish: "bg-ink",
  halt: "bg-flag-red",
  resume: "bg-flag-green",
  decision: "bg-flag-yellow",
  land: "bg-flag-green",
  cache: "bg-muted",
};
const Swatch = ({ k, pulse }: { k: string; pulse?: boolean }) => (
  <span className={`inline-block size-2.5 shrink-0 rounded-[2px] ${FLAG[k] ?? "bg-muted"} ${pulse ? "animate-pulse" : ""}`} />
);
const Flag = ({ k, children }: { k: string; children?: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider">
    <Swatch k={k} />
    {children ?? k}
  </span>
);

const VERDICT_BADGE = { auto: "success", review: "warning", blocked: "error" } as const;
const attemptFlag = (a: Attempt) => (a.state === "done" ? (a.report?.green ? "green" : "red") : a.state);
const boat = (id: string) => id.split("-").at(-1) ?? id;
const shortId = (id: string) => id.replace(/^c[a-z0-9]+-/, "");
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const card = "rounded-xl border border-rule bg-card";
const eyebrow = "text-xs font-bold uppercase tracking-[0.2em] text-muted";

// ---- app ----------------------------------------------------------------------
export default function Dashboard() {
  const route = useRoute();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setNotice(null), [route]);
  return (
    <div style={kumoTheme}>
      <Header route={route} notice={notice} setNotice={setNotice} />
      {route.name === "new" && <NewRace />}
      {route.name === "list" && <RaceList />}
      {route.name === "race" && <RacePage key={route.id} id={route.id} setNotice={setNotice} />}
      <footer className="mt-16 flex justify-center border-t border-rule pt-6 opacity-80">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}

function Header({ route, notice, setNotice }: { route: Route; notice: string | null; setNotice: (s: string | null) => void }) {
  const [theme, setTheme] = useState(document.documentElement.dataset.pref ?? "auto");
  const [askToken, setAskToken] = useState(false);
  const hasToken = Boolean(store.get("regatta-admin-token"));
  const cycleTheme = () => {
    const next = { auto: "light", light: "dark", dark: "auto" }[theme] ?? "auto";
    const root = document.documentElement;
    root.dataset.pref = next;
    root.dataset.mode = next === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : next;
    store.set("regatta-theme", next === "auto" ? null : next);
    setTheme(next);
  };
  return (
    <>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
        <a href="#/">
          <div className="font-display text-4xl font-extrabold italic leading-none tracking-tight">Regatta</div>
          <div className="mt-1.5 text-sm text-muted">Races, not pull requests.</div>
        </a>
        <nav className="flex items-center gap-2">
          <a href="#/">
            <Button variant={route.name === "list" ? "secondary" : "ghost"}>Races</Button>
          </a>
          <a href="#/new">
            <Button variant="primary">Start a race</Button>
          </a>
          <Button variant="ghost" onClick={cycleTheme} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
            {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
          </Button>
          <Button
            variant="ghost"
            aria-label="Admin token"
            title={hasToken ? "Clear admin token" : "Set admin token"}
            onClick={() => {
              if (hasToken) {
                store.set("regatta-admin-token", null);
                setNotice("Admin token cleared for this browser.");
              } else setAskToken(!askToken);
            }}
          >
            {hasToken ? "🔑" : "🔒"}
          </Button>
        </nav>
      </header>
      {askToken && (
        <form
          className={`${card} rise mb-6 flex items-end gap-3 p-4`}
          onSubmit={(e) => {
            e.preventDefault();
            const v = String(new FormData(e.currentTarget).get("token") ?? "").trim();
            store.set("regatta-admin-token", v || null);
            setAskToken(false);
            setNotice(v ? "Admin token saved in this browser." : null);
          }}
        >
          <div className="flex-1">
            <SensitiveInput name="token" placeholder="REGATTA_ADMIN_TOKEN" aria-label="Admin token" />
          </div>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      )}
      {notice && <div className={`${card} rise mb-6 px-4 py-3 text-sm`}>{notice}</div>}
    </>
  );
}

function RaceList() {
  const [races, setRaces] = useState<RaceSummary[] | null>(null);
  useEffect(() => {
    void api.GET("/api/races").then(({ data }) => setRaces(data ?? []));
  }, []);
  if (!races) return <Loader />;
  if (!races.length) {
    return (
      <section className={`${card} rise p-10`}>
        <Empty title="No races yet." description="One intent, many repos, competing agent forks that share what they learn." />
        <div className="mt-6 flex justify-center">
          <a href="#/new">
            <Button variant="primary">Start the first race</Button>
          </a>
        </div>
      </section>
    );
  }
  return (
    <section className={`${card} rise divide-y divide-rule`}>
      {races.map((r) => (
        <a key={r.id} href={`#/races/${encodeURIComponent(r.id)}`} className="flex items-baseline justify-between gap-4 px-5 py-4 hover:bg-paper">
          <span className="font-display text-lg leading-snug">{r.intent}</span>
          <span className="shrink-0 font-mono text-xs text-muted">
            {r.id} · {ago(r.createdAt)}
          </span>
        </a>
      ))}
    </section>
  );
}

const DEMO_TARGETS = [
  "jekyll-include-cache",
  "jekyll-optional-front-matter",
  "jekyll-readme-index",
  "jekyll-relative-links",
  "jekyll-remote-theme",
  "jekyll-titles-from-headings",
  "jekyll-default-layout",
].map((n) => `https://github.com/benbalter/${n}`);

function NewRace() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? "").trim();
    const targets = get("targets")
      .split(/\s+/)
      .filter(Boolean)
      .map((url) => ({ url, name: url.replace(/\.git$/, "").split("/").filter(Boolean).at(-1) ?? url }));
    setBusy(true);
    setError(null);
    const { data, error } = await api.POST("/api/races", { body: { intent: get("intent"), check: get("check"), k: Number(get("k")), targets } });
    setBusy(false);
    if (error) setError(error.error);
    else location.hash = `#/races/${data.id}`;
  };
  return (
    <form onSubmit={submit} className={`${card} rise grid gap-6 p-6 md:grid-cols-[2fr_1fr]`}>
      <div className="space-y-5">
        <InputArea
          label="Intent"
          name="intent"
          rows={3}
          required
          defaultValue="Pin the Ruby version for local development in a .ruby-version file (Ruby 3.4)."
          placeholder="What should every repo end up with?"
        />
        <InputArea label="Repos (one public HTTPS git URL per line)" name="targets" rows={8} required defaultValue={DEMO_TARGETS.join("\n")} className="font-mono" />
      </div>
      <div className="space-y-5">
        <Input label="Check (what passing means)" name="check" required defaultValue="bundle install --jobs 4 --quiet && bundle exec rspec" className="font-mono" />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Boats per repo</span>
          <select name="k" defaultValue="2" className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm">
            <option value="1">1: one attempt each</option>
            <option value="2">2: a race between two forks</option>
            <option value="3">3: three forks</option>
          </select>
          <span className="mt-2 block text-xs text-muted">Each boat is an agent working its own fork. The smallest green change wins by default.</span>
        </label>
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? "Starting…" : "Start the race"}
        </Button>
        {error && <p className="text-sm text-flag-red">{error}</p>}
      </div>
    </form>
  );
}

// ---- one race, live ---------------------------------------------------------
function RacePage({ id, setNotice }: { id: string; setNotice: (s: string | null) => void }) {
  const [race, setRace] = useState<Race | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => {
    const { data, error } = await api.GET("/api/races/{id}", { params: { path: { id } } });
    if (error) setError(error.error);
    else setRace(data);
  }, [id]);

  // The Race agent pushes a small state on every change; refetch the full view when it moves.
  useAgent<RaceLiveState>({
    agent: "race",
    name: id,
    onStateUpdate: (s) => setVersion(s.version),
  });
  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  if (error) return <p className="text-flag-red">{error}</p>;
  if (!race) return <Loader />;
  return <RaceView race={race} refresh={refresh} setNotice={setNotice} />;
}

function RaceView({ race: r, refresh, setNotice }: { race: Race; refresh: () => Promise<void>; setNotice: (s: string | null) => void }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of r.attempts) c[attemptFlag(a)] = (c[attemptFlag(a)] ?? 0) + 1;
    return c;
  }, [r.attempts]);
  return (
    <>
      <section className="rise mb-6">
        <div className="font-mono text-xs uppercase tracking-wider text-muted">
          Race {r.id} · started {ago(r.createdAt)} · check <code>{r.spec.check}</code>
        </div>
        <h1 className="mt-2 max-w-4xl font-display text-3xl leading-tight md:text-4xl">{r.spec.intent}</h1>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          <Flag k="running">{counts.running ?? 0} sailing</Flag>
          <Flag k="green">{counts.green ?? 0} green</Flag>
          <Flag k="red">{counts.red ?? 0} red</Flag>
          <Flag k="landed">{counts.landed ?? 0} landed</Flag>
          <Flag k="halted">{counts.halted ?? 0} halted</Flag>
          <span className="text-xs font-medium uppercase tracking-wider text-muted">
            {r.spec.targets.length} repos · {r.spec.k} boats each · {r.fixes.length} fixes shared
          </span>
        </div>
      </section>
      <Andon race={r} refresh={refresh} setNotice={setNotice} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <Course race={r} />
          <Clusters race={r} refresh={refresh} setNotice={setNotice} />
          <Blackboard race={r} />
          <WhyBox race={r} />
        </div>
        <aside className="min-w-0">
          <RaceLog feed={r.feed} />
        </aside>
      </div>
    </>
  );
}

function Andon({ race: r, refresh, setNotice }: { race: Race; refresh: () => Promise<void>; setNotice: (s: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (r.halt) {
    return (
      <section className="rise mb-6 rounded-xl border-2 border-flag-red bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.2em] text-flag-red">The line is stopped</div>
            <p className="mt-1 font-display text-xl">{r.halt.reason}</p>
            <p className="mt-1 text-sm text-muted">
              Pulled by {r.halt.by} · {ago(r.halt.at)}. Nothing launches or lands until it's released.
            </p>
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const { data, error } = await api.POST("/api/races/{id}/resume", { params: { path: { id: r.id } }, body: {} });
              setBusy(false);
              setNotice(error ? `Couldn't resume: ${error.error}` : `Line released. Relaunched: ${data.relaunched.join(", ") || "nothing"}.`);
              await refresh();
            }}
          >
            Release the line and relaunch
          </Button>
        </div>
      </section>
    );
  }
  if (!open) {
    return (
      <div className="mb-6 flex justify-end">
        <Button variant="secondary-destructive" onClick={() => setOpen(true)}>
          ⛔ Pull the andon cord
        </Button>
      </div>
    );
  }
  return (
    <form
      className="rise mb-6 flex flex-wrap items-end gap-3 rounded-xl border-2 border-flag-red bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
        setBusy(true);
        const { error } = await api.POST("/api/races/{id}/halt", { params: { path: { id: r.id } }, body: { reason, by: store.get("regatta-approver") ?? undefined } });
        setBusy(false);
        setOpen(false);
        if (error) setNotice(`Couldn't stop the line: ${error.error}`);
        await refresh();
      }}
    >
      <div className="min-w-64 flex-1">
        <Input label="Why stop every agent in this race?" name="reason" required autoFocus placeholder="e.g. the intent breaks repos that still support Ruby 3.1" />
      </div>
      <Button type="submit" variant="destructive" disabled={busy}>
        Stop the line
      </Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

// Repos down the side, boats (competing forks) across: the race at a glance.
function Course({ race: r }: { race: Race }) {
  return (
    <section className={`${card} rise overflow-hidden`}>
      <div className="flex items-baseline justify-between border-b border-rule px-5 py-3">
        <h2 className="font-display text-xl">The course</h2>
        <span className="text-xs text-muted">repos × competing forks</span>
      </div>
      <div className="divide-y divide-rule">
        {r.spec.targets.map((t) => {
          const sync = r.sync[t.name];
          const boats = r.attempts.filter((a) => a.target === t.name);
          return (
            <div key={t.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="w-56 min-w-0 shrink-0">
                <div className="truncate font-mono text-sm">{t.name}</div>
                <div className="text-xs text-muted">{sync ? `base ${sync.status}` : "waiting"}</div>
              </div>
              <div className="flex flex-1 flex-wrap gap-2">
                {boats.length ? (
                  boats.map((a) => <BoatChip key={a.id} a={a} />)
                ) : (
                  <span className="text-xs text-muted">{sync?.status === "conflict" ? "skipped: upstream sync conflict" : "launching…"}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BoatChip({ a }: { a: Attempt }) {
  const f = attemptFlag(a);
  const tip = [a.announcement ? `Plan: ${a.announcement.plan}` : "Not announced yet", a.report?.summary, a.undeclared.length ? `Undeclared: ${a.undeclared.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <span title={tip} className="inline-flex items-center gap-2 rounded-full border border-rule bg-paper px-3 py-1 font-mono text-xs">
      <Swatch k={f} pulse={f === "running"} />
      {boat(a.id)}
      {a.retryOf && <span className="text-muted">↻ {a.hints.length ? "seeded" : "relaunch"}</span>}
      {a.report && (
        <span className="text-muted">
          {a.report.green ? `+${a.report.diffSize}` : "✕"} · {a.report.turns}t
        </span>
      )}
      {a.undeclared.length > 0 && (
        <span className="text-flag-yellow" title="Changed files it never announced">
          ⚑
        </span>
      )}
    </span>
  );
}

function Clusters({ race: r, refresh, setNotice }: { race: Race; refresh: () => Promise<void>; setNotice: (s: string | null) => void }) {
  if (!r.clusters.length) {
    return <section className={`${card} rise p-6 text-sm text-muted`}>Results group into outcome clusters as boats finish. You review once per cluster, not once per repo.</section>;
  }
  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-2xl">Outcome clusters</h2>
        <span className="text-xs text-muted">review once per cluster, not once per repo</span>
      </div>
      {r.clusters.map((c) => (
        <ClusterCard key={c.key} race={r} c={c} refresh={refresh} setNotice={setNotice} />
      ))}
    </section>
  );
}

function ClusterCard({ race: r, c, refresh, setNotice }: { race: Race; c: Cluster; refresh: () => Promise<void>; setNotice: (s: string | null) => void }) {
  const doc = r.decisionDocs[c.key];
  const approved = r.approved.includes(c.key);
  const landing = Object.values(c.winners)
    .map((id) => r.attempts.find((a) => a.id === id))
    .filter((a): a is Attempt => Boolean(a));
  const [busy, setBusy] = useState(false);
  const approve = async (body: { approvedBy: string; dissentResponse?: string }) => {
    setBusy(true);
    const { data, error } = await api.POST("/api/races/{id}/approve", { params: { path: { id: r.id } }, body: { key: c.key, ...body } });
    setBusy(false);
    setNotice(error ? `Not landed: ${error.error}` : `Landing ${data.landing.length} repo(s).`);
    await refresh();
  };
  const accent = { blocked: "border-l-flag-red", review: "border-l-flag-yellow", auto: "border-l-flag-green" }[c.verdict.decision];
  const inFlight = approved || landing.some((a) => a.state === "landing" || a.state === "landed");
  return (
    <article className={`${card} ${accent} rise border-l-4 p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={c.kind === "failing" ? "error" : c.kind === "green" ? "success" : "neutral"}>{c.kind}</Badge>
            <Badge variant={VERDICT_BADGE[c.verdict.decision]}>{c.verdict.decision}</Badge>
          </div>
          <h3 className="mt-2 break-words font-mono text-sm">{c.label}</h3>
          <p className="mt-1 text-sm text-muted">
            {c.targets.length} repo{c.targets.length === 1 ? "" : "s"}: {c.targets.join(", ")}
          </p>
          <ul className="mt-2 space-y-0.5 text-sm">
            {c.verdict.reasons.map((x) => (
              <li key={x}>· {x}</li>
            ))}
          </ul>
        </div>
        <div className="text-right text-sm">
          {c.verdict.decision === "blocked" ? (
            <span className="text-muted">Blocked until it's green.</span>
          ) : inFlight ? (
            landing.map((a) => (
              <div key={a.id}>
                <Flag k={a.state === "done" ? "landing" : a.state}>
                  {a.target}: {a.state === "landed" ? `landed ${a.landedSha?.slice(0, 7)}` : a.state}
                </Flag>
              </div>
            ))
          ) : c.verdict.decision === "auto" ? (
            <Button variant="primary" disabled={busy} onClick={() => approve({ approvedBy: "policy (auto)" })}>
              Land {landing.length} by policy
            </Button>
          ) : null}
        </div>
      </div>
      {doc ? (
        <DecisionDocView doc={doc} approved={approved} busy={busy} landingCount={Object.keys(c.winners).length} onApprove={approve} />
      ) : (
        c.verdict.decision === "review" && <p className="mt-4 text-sm text-muted">Writing the decision doc… it appears once every boat in the race has finished.</p>
      )}
      <Tournament race={r} c={c} />
    </article>
  );
}

function DecisionDocView({
  doc,
  approved,
  busy,
  landingCount,
  onApprove,
}: {
  doc: DecisionDoc;
  approved: boolean;
  busy: boolean;
  landingCount: number;
  onApprove: (b: { approvedBy: string; dissentResponse?: string }) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [name, setName] = useState(store.get("regatta-approver") ?? "");
  return (
    <div className="mt-5 grid gap-4 border-t border-rule pt-5 md:grid-cols-2">
      <div className="space-y-3 text-sm">
        <div className={eyebrow}>Decision doc · {doc.model}</div>
        <p>
          <span className="font-semibold">Problem.</span> {doc.problem}
        </p>
        {doc.options.length > 0 && (
          <ol className="space-y-2">
            {doc.options.map((o) => (
              <li key={o.attempt} className="rounded-lg border border-rule p-3">
                <div className="font-mono text-xs">
                  {shortId(o.attempt)} · {o.target}
                </div>
                <div className="mt-1">{o.summary}</div>
                <div className="mt-1 text-muted">{o.tradeoffs}</div>
              </li>
            ))}
          </ol>
        )}
        <p>
          <span className="font-semibold">Recommendation.</span> {doc.recommendation}
        </p>
        <p className="font-display text-lg italic">{doc.ask}</p>
      </div>
      <div className="space-y-3 text-sm">
        {doc.dissent ? (
          <div className="rounded-lg border-2 border-dashed border-flag-red p-4">
            <div className="text-xs font-bold uppercase tracking-[0.2em] text-flag-red">Dissent · {doc.dissent.model}</div>
            <p className="mt-2">{doc.dissent.argument}</p>
            <p className="mt-2 text-muted">
              <span className="font-semibold text-ink">Strongest alternative.</span> {doc.dissent.strongestAlternative}
            </p>
          </div>
        ) : (
          <p className="text-muted">No dissent was raised.</p>
        )}
        {!approved && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name) store.set("regatta-approver", name);
              void onApprove({ approvedBy: name || "a human reviewer", dissentResponse: answer.trim() || undefined }).then(() => setAnswer(""));
            }}
          >
            <InputArea
              label={doc.dissent ? "Your answer to the dissent (recorded on the merge)" : "Note for the record (optional)"}
              rows={3}
              required={Boolean(doc.dissent)}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div className="flex items-end gap-2">
              <Input label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" variant="primary" disabled={busy}>
                Approve and land {landingCount}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// Agent-written diffs are untrusted: diff2html escapes them, and DOMPurify checks its output anyway.
const diffHtml = (diff: string) =>
  DOMPurify.sanitize(renderDiff(diff, { drawFileList: false, outputFormat: "side-by-side", matching: "lines", colorScheme: ColorSchemeType.AUTO }));

// Best-of-K: every boat that raced in this cluster, side by side.
function Tournament({ race: r, c }: { race: Race; c: Cluster }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const ids = new Set(c.attempts.map((a) => a.attemptId));
  const boats = r.attempts.filter((a) => ids.has(a.id));
  if (!boats.some((b) => b.report?.diff)) return null;
  return (
    <details className="mt-5 border-t border-rule pt-4">
      <summary className="cursor-pointer text-sm font-semibold">Compare the forks ({boats.length})</summary>
      <div className="mt-4 space-y-4">
        {boats.map((b) => {
          const winner = Object.values(c.winners).includes(b.id);
          return (
            <div key={b.id} className={`rounded-lg border p-4 ${winner ? "border-flag-green" : "border-rule"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-sm">
                  {b.target} · {boat(b.id)} {winner && <span className="text-flag-green">★ default winner</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted">
                  ±{b.report?.diffSize ?? 0} lines · {b.report?.turns ?? 0} turns
                  <Button size="sm" variant="outline" onClick={() => setOpen({ ...open, [b.id]: !open[b.id] })}>
                    {open[b.id] ? "Hide diff" : "Show diff"}
                  </Button>
                </div>
              </div>
              {b.announcement && (
                <p className="mt-2 text-sm">
                  <span className="text-muted">Announced:</span> {b.announcement.plan}
                </p>
              )}
              {b.report?.rationale && (
                <p className="mt-1 text-sm">
                  <span className="text-muted">Why:</span> {b.report.rationale}
                </p>
              )}
              {open[b.id] && b.report?.diff && <div className="mt-3 overflow-x-auto text-xs" dangerouslySetInnerHTML={{ __html: diffHtml(b.report.diff) }} />}
            </div>
          );
        })}
      </div>
    </details>
  );
}

// The blackboard: fixes one boat found, and the boats they unblocked.
function Blackboard({ race: r }: { race: Race }) {
  if (!r.fixes.length) return null;
  return (
    <section className={`${card} rise p-5`}>
      <h2 className="font-display text-xl">The blackboard</h2>
      <p className="text-sm text-muted">One repo's fix, offered to every boat that hits the same error.</p>
      <div className="mt-4 space-y-3">
        {r.fixes.map((f) => {
          const helped = r.attempts.filter((a) => a.hints.some((x) => x.startsWith(`${f.target} hit`) && x.includes(f.signature)));
          return (
            <div key={f.id} className="rounded-lg border border-rule p-4">
              <div className="font-mono text-xs text-flag-red">{f.signature}</div>
              <div className="mt-1 text-sm">
                Fixed in <span className="font-mono">{f.target}</span> by {shortId(f.attemptId)}
              </div>
              {helped.length ? (
                <div className="mt-2 text-sm">
                  → seeded{" "}
                  {helped.map((a) => (
                    <span key={a.id} className="mr-2 font-mono">
                      {a.target} ({attemptFlag(a)})
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-xs text-muted">No other boat has needed it yet.</div>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted">The fix</summary>
                <pre className="mt-2 overflow-x-auto font-mono text-xs">{f.diff}</pre>
              </details>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WhyBox({ race: r }: { race: Race }) {
  const bases = [...new Set(r.attempts.map((a) => a.base))];
  const [answer, setAnswer] = useState<WhyAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { data, error } = await api.GET("/api/why", {
      params: { query: { repo: String(fd.get("repo")), path: String(fd.get("path")), line: Number(fd.get("line")) } },
    });
    setBusy(false);
    setAnswer(data ?? null);
    if (error) setError(error.error);
  };
  return (
    <section className={`${card} rise p-5`}>
      <h2 className="font-display text-xl">Why is this line here?</h2>
      <p className="text-sm text-muted">Blame answers who. Regatta answers why, and who decided.</p>
      <form onSubmit={ask} className="mt-4 grid items-end gap-2 sm:grid-cols-[1fr_1fr_90px_auto]">
        <select name="repo" aria-label="Repository" className="rounded-lg border border-rule bg-paper px-3 py-2 font-mono text-sm">
          {bases.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
        <Input aria-label="Path" name="path" required placeholder=".ruby-version" className="font-mono" />
        <Input aria-label="Line" name="line" type="number" min={1} required defaultValue="1" className="font-mono" />
        <Button type="submit" variant="primary" disabled={busy}>
          Ask why
        </Button>
      </form>
      {error && <p className="mt-3 text-sm text-flag-red">{error}</p>}
      {answer && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-rule p-4 text-sm">
            <div className={eyebrow}>The change · {answer.commit.sha.slice(0, 7)}</div>
            <pre className="mt-2 overflow-x-auto rounded bg-paper p-2 font-mono text-xs">
              {answer.line}: {answer.text}
            </pre>
            <p className="mt-2 font-semibold">{answer.commit.subject}</p>
            <Trailers t={answer.commit.trailers} keys={["intent", "problem", "alternatives", "rationale"]} />
          </div>
          <div className="rounded-lg border border-rule p-4 text-sm">
            <div className={eyebrow}>The decision {answer.landing && `· ${answer.landing.sha.slice(0, 7)}`}</div>
            {answer.landing ? (
              <Trailers t={answer.landing.trailers} keys={["decision", "approvedBy", "dissent", "dissentResponse"]} />
            ) : (
              <p className="mt-2 text-muted">Not landed through Regatta.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const TRAILER_NAMES: Record<string, string> = { approvedBy: "Approved by", dissentResponse: "Answer to the dissent" };
function Trailers({ t, keys }: { t: Record<string, string | undefined>; keys: string[] }) {
  const rows = keys.filter((k) => t[k]);
  if (!rows.length) return <p className="mt-2 text-muted">No Regatta trailers on this commit.</p>;
  return (
    <dl className="mt-2 space-y-2">
      {rows.map((k) => (
        <div key={k}>
          <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{TRAILER_NAMES[k] ?? k}</dt>
          <dd>{t[k]}</dd>
        </div>
      ))}
    </dl>
  );
}

function RaceLog({ feed }: { feed: FeedEvent[] }) {
  const events = [...feed].reverse();
  return (
    <section className={`${card} rise sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col`}>
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-3">
        <h2 className="font-display text-xl">Race log</h2>
        <span className="text-xs text-muted">agents work loudly</span>
      </div>
      <ol className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {events.length ? (
          events.map((e) => (
            <li key={e.id} className="grid grid-cols-[10px_1fr] gap-x-2">
              <span className="mt-1.5">
                <Swatch k={e.kind} />
              </span>
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase tracking-wider text-muted">
                  {e.at.slice(11, 19)} · {e.kind}
                  {e.target && ` · ${e.target}`}
                  {e.attempt && ` · ${boat(e.attempt)}`}
                </div>
                <div className="break-words text-sm">{e.text}</div>
              </div>
            </li>
          ))
        ) : (
          <li className="text-sm text-muted">Waiting for the start gun…</li>
        )}
      </ol>
    </section>
  );
}
