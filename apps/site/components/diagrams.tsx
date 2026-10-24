// Diagrams drawn in HTML and SVG with the brand's tokens, so they follow the theme and stay sharp at any size.
import { agentColorVar } from "@brio/brand";
import { Fragment, type ReactElement } from "react";
import { FLOW, STEPS } from "@/lib/content";
import { CHAT_MODES, TASK_STATES } from "@/lib/product";

const GIST: Record<(typeof STEPS)[number]["key"], string> = {
  plan: "tasks + contracts",
  route: "best agent per task",
  coordinate: "leases · handoffs",
  verify: "checks · review",
  learn: "the scoreboard",
  govern: "budgets · approvals",
};

/** The six steps of a mission, left to right (top to bottom on a phone), with learning feeding routing. */
export function Pipeline() {
  return (
    <figure aria-label="Plan, route, coordinate, verify, learn, govern">
      <ol className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center">
        {STEPS.map((s, i) => (
          <Fragment key={s.key}>
            <li className="flex-1 rounded-lg border border-line bg-surface p-4">
              <span className="font-mono text-2xs text-fg-subtle">0{i + 1}</span>
              <p className="mt-1 font-mono text-sm font-bold text-fg">{s.title}</p>
              <p className="mt-1 font-mono text-2xs text-fg-muted">{GIST[s.key]}</p>
            </li>
            {i < STEPS.length - 1 ? (
              <li aria-hidden className="text-center font-mono text-accent lg:px-0.5">
                <span className="lg:hidden">↓</span>
                <span className="hidden lg:inline">→</span>
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
      <figcaption className="mt-3 flex items-center gap-2 font-mono text-2xs text-fg-subtle">
        <span className="text-accent" aria-hidden>
          ↺
        </span>
        every verdict goes back into routing: the next mission picks agents on what this one learned
      </figcaption>
    </figure>
  );
}

type Node = { key: string; type: string; title: string; agent: number; x: number; y: number };

const NODES: Node[] = [
  { key: "t1", type: "design.api_contract", title: "health API contract", agent: 0, x: 20, y: 120 },
  { key: "t2", type: "code.feature", title: "GET /health route", agent: 1, x: 205, y: 40 },
  { key: "t3", type: "code.frontend_ui", title: "status badge", agent: 2, x: 205, y: 200 },
  { key: "t4", type: "code.tests", title: "route tests", agent: 1, x: 392, y: 40 },
  { key: "t5", type: "write.doc", title: "API + badge docs", agent: 3, x: 392, y: 200 },
  { key: "t6", type: "merge.integrate", title: "integrate + report", agent: 0, x: 580, y: 120 },
];
const EDGES: Array<[string, string]> = [
  ["t1", "t2"],
  ["t1", "t3"],
  ["t2", "t4"],
  ["t3", "t5"],
  ["t4", "t6"],
  ["t5", "t6"],
];
const W = 160;
const H = 64;

/** A planned mission: tasks with types, the contract task first, dependencies as arrows. */
export function PlanGraph() {
  const at = (k: string) => NODES.find((n) => n.key === k) as Node;
  return (
    <figure className="overflow-x-auto rounded-lg border border-line bg-surface p-4">
      <svg
        viewBox="0 0 760 290"
        className="mx-auto block w-full min-w-[640px] max-w-[900px]"
        role="img"
        aria-label="A plan: a contract task first, two tasks that depend on it, tests and docs, then an integration task"
      >
        <defs>
          <marker
            id="plan-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8z" className="fill-line-strong" />
          </marker>
        </defs>
        {EDGES.map(([a, b]) => {
          const from = at(a);
          const to = at(b);
          const x1 = from.x + W;
          const y1 = from.y + H / 2;
          const x2 = to.x;
          const y2 = to.y + H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={`${a}-${b}`}
              d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2 - 2} ${y2}`}
              className="fill-none stroke-line-strong"
              strokeWidth="1.5"
              markerEnd="url(#plan-arrow)"
            />
          );
        })}
        {NODES.map((n) => (
          <g key={n.key} transform={`translate(${n.x} ${n.y})`}>
            <rect width={W} height={H} rx="8" className="fill-bg stroke-line" strokeWidth="1" />
            <rect x="0" y="0" width="3" height={H} rx="1.5" style={{ fill: agentColorVar(n.agent) }} />
            <text x="12" y="20" className="fill-fg-subtle font-mono" fontSize="9">
              {n.key} · {n.type}
            </text>
            <text x="12" y="40" className="fill-fg font-mono" fontSize="11" fontWeight="700">
              {n.title}
            </text>
            <text x="12" y="56" className="fill-fg-muted font-mono" fontSize="9">
              contract ✓ · checks ✓
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-3 font-mono text-2xs text-fg-subtle">
        plan v1 · 6 tasks · the shared contract (t1) comes first, so parallel work agrees on the interface
      </figcaption>
    </figure>
  );
}

/** The task state machine: the happy path, the revise loop, and what blocks or fails. */
export function StateMachine() {
  const step = 118;
  return (
    <figure className="overflow-x-auto rounded-lg border border-line bg-surface p-4">
      <svg
        viewBox="0 0 740 230"
        className="mx-auto block w-full min-w-[640px] max-w-[900px]"
        role="img"
        aria-label="pending, ready, leased, running, verifying, done; verifying can send work back to running (revise) or fail it; any state can block or be cancelled"
      >
        <defs>
          <marker
            id="sm-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8z" className="fill-line-strong" />
          </marker>
          <marker
            id="sm-arrow-accent"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0L8 4L0 8z" className="fill-accent" />
          </marker>
        </defs>
        {TASK_STATES.map((s, i) => {
          const x = 10 + i * step;
          const last = i === TASK_STATES.length - 1;
          return (
            <g key={s}>
              <rect
                x={x}
                y="80"
                width="96"
                height="36"
                rx="6"
                className={
                  last
                    ? "fill-bg stroke-success"
                    : s === "running"
                      ? "fill-bg stroke-accent"
                      : "fill-bg stroke-line"
                }
                strokeWidth="1.2"
              />
              <text x={x + 48} y="102" textAnchor="middle" className="fill-fg font-mono" fontSize="12">
                {s}
              </text>
              {!last ? (
                <path
                  d={`M${x + 96} 98 L${x + step - 2} 98`}
                  className="stroke-line-strong"
                  strokeWidth="1.5"
                  markerEnd="url(#sm-arrow)"
                />
              ) : null}
            </g>
          );
        })}
        {/* verifying → running: revise */}
        <path
          d={`M${10 + 4 * step + 48} 80 C${10 + 4 * step + 48} 30 ${10 + 3 * step + 48} 30 ${10 + 3 * step + 48} 78`}
          className="fill-none stroke-accent"
          strokeWidth="1.5"
          markerEnd="url(#sm-arrow-accent)"
        />
        <text
          x={10 + 3.5 * step + 48}
          y="28"
          textAnchor="middle"
          className="fill-accent font-mono"
          fontSize="11"
        >
          revise (≤ 2, then reroute)
        </text>
        {/* verifying → failed */}
        <path
          d={`M${10 + 4 * step + 48} 116 L${10 + 4 * step + 48} 168`}
          className="stroke-line-strong"
          strokeWidth="1.5"
          markerEnd="url(#sm-arrow)"
        />
        <rect
          x={10 + 4 * step}
          y="170"
          width="96"
          height="36"
          rx="6"
          className="fill-bg stroke-danger"
          strokeWidth="1.2"
        />
        <text x={10 + 4 * step + 48} y="192" textAnchor="middle" className="fill-fg font-mono" fontSize="12">
          failed
        </text>
        <text x={10 + 4 * step + 106} y="192" className="fill-fg-subtle font-mono" fontSize="10">
          → re-plan proposal
        </text>
        {/* blocked */}
        <rect
          x="10"
          y="170"
          width="430"
          height="36"
          rx="6"
          className="fill-bg stroke-warning"
          strokeWidth="1.2"
          strokeDasharray="4 3"
        />
        <text x="225" y="186" textAnchor="middle" className="fill-fg font-mono" fontSize="12">
          blocked
        </text>
        <text x="225" y="200" textAnchor="middle" className="fill-fg-subtle font-mono" fontSize="9">
          lease denied · approval pending · budget stop → ready when cleared
        </text>
      </svg>
    </figure>
  );
}

/** Inside the runner: the sandbox around one attempt, and what may leave it. */
export function Sandbox() {
  return (
    <figure
      className="rounded-lg border border-line bg-surface p-4 sm:p-6"
      aria-label="One attempt's sandbox"
    >
      <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-subtle">runner host · Docker</p>
      <div className="mt-3 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-md border border-accent p-4">
          <p className="font-mono text-xs text-accent">container · one per attempt</p>
          <ul className="mt-3 grid gap-2 font-mono text-2xs text-fg-muted sm:grid-cols-2">
            {[
              "non-root user, no capabilities",
              "read-only base image",
              "writable: the worktree and /tmp only",
              "no Docker socket, no host mounts",
              "CPU, memory, disk and PID limits",
              "a wall-clock limit, then killed",
            ].map((t) => (
              <li key={t} className="rounded-sm border border-line bg-bg px-2 py-1.5">
                {t}
              </li>
            ))}
          </ul>
          <div className="mt-3 rounded-sm border border-line bg-bg p-3 font-mono text-2xs text-fg-muted">
            <span className="text-fg">/work</span> · branch brio/&lt;mission&gt;/&lt;task&gt;/&lt;attempt&gt;
            <br />
            .brio/brief.md · .brio/contract.json · .brio/handoff.json
          </div>
        </div>
        <div className="flex flex-col justify-center gap-2 font-mono text-2xs">
          <p className="text-fg-subtle">egress: default deny, through a proxy</p>
          {[
            ["api.vendor.com", "the agent's own vendor", true],
            ["registry.npmjs.org", "package registries", true],
            ["github.com", "the project's host", true],
            ["anything else", "refused, and logged", false],
          ].map(([host, why, ok]) => (
            <div
              key={host as string}
              className="flex items-center justify-between gap-3 rounded-sm border border-line bg-bg px-3 py-2"
            >
              <span className="text-fg">{host as string}</span>
              <span className={ok ? "text-success" : "text-danger"}>{ok ? "✓" : "✗"}</span>
              <span className="hidden text-fg-subtle sm:inline">{why as string}</span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

/** Chat's four modes as tiny pictures of who talks to whom. */
export function ChatModes() {
  const dot = (x: number, y: number, i: number, label: string) => (
    <g>
      <circle cx={x} cy={y} r="11" style={{ fill: agentColorVar(i) }} />
      <text x={x} y={y + 4} textAnchor="middle" className="fill-bg font-mono" fontSize="10" fontWeight="700">
        {label}
      </text>
    </g>
  );
  const you = (x: number, y: number) => (
    <g>
      <rect x={x - 16} y={y - 10} width="32" height="20" rx="4" className="fill-bg stroke-line-strong" />
      <text x={x} y={y + 4} textAnchor="middle" className="fill-fg font-mono" fontSize="9">
        you
      </text>
    </g>
  );
  const line = (d: string, accent = false) => (
    <path
      d={d}
      className={`fill-none ${accent ? "stroke-accent" : "stroke-line-strong"}`}
      strokeWidth="1.4"
    />
  );
  const pictures: Record<(typeof CHAT_MODES)[number]["key"], ReactElement> = {
    auto: (
      <>
        {line("M40 50 L120 50")}
        {you(28, 50)}
        {dot(132, 50, 0, "A")}
        <text x="132" y="80" textAnchor="middle" className="fill-fg-subtle font-mono" fontSize="9">
          best at it
        </text>
      </>
    ),
    together: (
      <>
        {line("M44 50 L76 26 M44 50 L76 74")}
        {line("M98 26 L126 50 M98 74 L126 50", true)}
        {you(28, 50)}
        {dot(88, 26, 0, "A")}
        {dot(88, 74, 1, "B")}
        {dot(138, 50, 2, "M")}
      </>
    ),
    review: (
      <>
        {line("M44 50 L76 50")}
        {line("M98 44 C110 30 118 30 128 44", true)}
        {line("M128 56 C118 70 110 70 98 56")}
        {you(28, 50)}
        {dot(88, 50, 0, "A")}
        {dot(138, 50, 1, "B")}
        <text x="113" y="86" textAnchor="middle" className="fill-fg-subtle font-mono" fontSize="9">
          checks · fixes
        </text>
      </>
    ),
    debate: (
      <>
        {line("M44 50 L76 30 M44 50 L76 70")}
        {line("M88 40 L88 60", true)}
        {line("M98 30 L126 48 M98 70 L126 52")}
        {you(28, 50)}
        {dot(88, 26, 0, "A")}
        {dot(88, 74, 1, "B")}
        {dot(138, 50, 2, "J")}
      </>
    ),
  };
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
      {CHAT_MODES.map((m) => (
        <div key={m.key} className="flex flex-col bg-bg p-5">
          <svg viewBox="0 0 160 100" className="h-24 w-full" role="img" aria-label={`${m.title}: ${m.body}`}>
            {pictures[m.key]}
          </svg>
          <div className="mt-3 flex items-center justify-between gap-2">
            <h3 className="font-mono text-sm font-bold text-fg">{m.title}</h3>
            <span className="rounded-xs border border-line px-1.5 font-mono text-2xs text-fg-subtle">
              {m.needs}
            </span>
          </div>
          <p className="mt-2 flex-1 text-sm text-fg-muted">{m.body}</p>
          <p className="mt-3 font-mono text-2xs text-fg-subtle">mode: {m.mode}</p>
        </div>
      ))}
    </div>
  );
}

/** How the router weighs candidates for one task: a sampled quality, its pairwise strength, cost and speed. */
export function RouterBars() {
  const rows = [
    { agent: "codex", q: 82, cost: "$0.31", time: "2m14s", n: 41, pick: true },
    { agent: "claude-code", q: 79, cost: "$0.42", time: "3m02s", n: 37, pick: false },
    { agent: "gemini", q: 64, cost: "$0.09", time: "1m40s", n: 12, pick: false },
  ];
  return (
    <figure className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <p className="font-mono text-2xs text-fg-subtle">task 3 · code.tests · priority: balanced</p>
      <ul className="mt-4 space-y-3">
        {rows.map((r, i) => (
          <li key={r.agent}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 font-mono text-xs">
              <span className="flex items-center gap-2 text-fg">
                <span className="h-2 w-2 rounded-xs" style={{ background: agentColorVar(i) }} aria-hidden />
                {r.agent}
                {r.pick ? <span className="text-accent">← picked</span> : null}
              </span>
              <span className="text-fg-subtle">
                {r.q / 100} pass · {r.cost} · {r.time} · n={r.n}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-xs bg-surface-2">
              <div
                className={`h-full rounded-xs ${r.pick ? "bg-accent" : "bg-line-strong"}`}
                style={{ width: `${r.q}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <figcaption className="mt-4 border-t border-line pt-3 font-mono text-2xs text-fg-muted">
        rationale · codex: 0.82 pass rate on code.tests (n=41), $0.31 avg, beats claude-code on cost at
        similar quality
      </figcaption>
    </figure>
  );
}

/** Where things run: you, your Brio, your runners, the vendors you chose. */
export function WhereItRuns() {
  return (
    <ol className="grid gap-3 md:grid-cols-4" aria-label="Where things run">
      {FLOW.map((f, i) => (
        <li key={f.name} className="relative rounded-lg border border-line bg-surface p-4">
          <p className="font-mono text-sm font-bold text-fg">{f.name}</p>
          <ul className="mt-2 space-y-1">
            {f.items.map((item) => (
              <li key={item} className="font-mono text-2xs text-fg-muted">
                {item}
              </li>
            ))}
          </ul>
          {i < FLOW.length - 1 ? (
            <span
              className="absolute -right-3 top-1/2 z-[1] hidden -translate-y-1/2 font-mono text-md text-accent md:block"
              aria-hidden
            >
              →
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Envelope encryption: a key per secret, wrapped by the deployment's key; opened only inside an attempt. */
export function Vault() {
  const steps = [
    ["you", "paste a vendor key once"],
    ["vault", "a fresh data key encrypts it (XChaCha20-Poly1305)"],
    ["KEK", "the data key is wrapped by a master key (KMS or a key file)"],
    ["database", "only ciphertext is stored; the key is never shown again"],
    ["runner", "unwrapped in memory for one attempt, sent as a header"],
    ["after", "zeroed; logs and events are redacted"],
  ];
  return (
    <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
      {steps.map(([who, what], i) => (
        <li key={who} className="bg-bg p-4">
          <span className="font-mono text-2xs text-fg-subtle">0{i + 1}</span>
          <p className="mt-1 font-mono text-sm font-bold text-fg">{who}</p>
          <p className="mt-1 text-sm text-fg-muted">{what}</p>
        </li>
      ))}
    </ol>
  );
}

/** The ledger: each entry carries the hash of the one before it. */
export function LedgerChain() {
  const entries = [
    { seq: 41, kind: "dispatch", detail: "codex → t3", hash: "9f2c…a1" },
    { seq: 42, kind: "spend", detail: "$0.31 · t3", hash: "4be0…7d" },
    { seq: 43, kind: "approval", detail: "PR #42 · approved", hash: "c71a…02" },
    { seq: 44, kind: "side effect", detail: "pushed brio/health", hash: "e5d9…3f" },
  ];
  return (
    <figure className="overflow-x-auto">
      <ol className="flex min-w-[640px] items-stretch gap-2">
        {entries.map((e, i) => (
          <Fragment key={e.seq}>
            <li className="flex-1 rounded-lg border border-line bg-surface p-3 font-mono text-2xs">
              <p className="text-fg-subtle">seq {e.seq}</p>
              <p className="mt-1 text-sm font-bold text-fg">{e.kind}</p>
              <p className="mt-1 text-fg-muted">{e.detail}</p>
              <p className="mt-2 border-t border-line pt-2 text-fg-subtle">
                prev {i === 0 ? "3a8e…c4" : entries[i - 1]?.hash}
              </p>
              <p className="text-accent">hash {e.hash}</p>
            </li>
            {i < entries.length - 1 ? (
              <li aria-hidden className="self-center font-mono text-accent">
                →
              </li>
            ) : null}
          </Fragment>
        ))}
      </ol>
      <figcaption className="mt-3 font-mono text-2xs text-fg-subtle">
        hash = sha256(prev_hash ‖ canonical_json(entry)) · triggers refuse every update and delete
      </figcaption>
    </figure>
  );
}

/** The layers of Brio, top to bottom. */
export function Layers() {
  const layers = [
    ["Surfaces", ["web app", "brio CLI", "MCP server", "A2A server", "REST API + SDK"]],
    [
      "Orchestrator",
      ["planner", "router", "scheduler", "leases + contracts", "mailbox", "verifier", "scoreboard", "memory"],
    ],
    ["Governance", ["budgets", "policies + approvals", "audit ledger", "BYOK vault"]],
    ["Execution", ["pg-boss queue", "runners", "a sandbox per attempt", "local runners"]],
    [
      "Connectors",
      ["model APIs", "coding CLIs", "hosted agents", "A2A agents", "MCP tools", "browser", "media"],
    ],
  ] as const;
  return (
    <ol className="space-y-2" aria-label="Brio's layers">
      {layers.map(([name, parts], i) => (
        <li
          key={name}
          className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[150px_1fr] sm:items-center"
        >
          <p className="font-mono text-sm font-bold text-fg">
            <span className="mr-2 text-fg-subtle">{i + 1}</span>
            {name}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {parts.map((p) => (
              <li
                key={p}
                className="rounded-sm border border-line bg-bg px-2 py-1 font-mono text-2xs text-fg-muted"
              >
                {p}
              </li>
            ))}
          </ul>
        </li>
      ))}
      <li className="pt-1 font-mono text-2xs text-fg-subtle">
        the brain decides, runners execute, governance can veto anything, events record everything · one
        Postgres
      </li>
    </ol>
  );
}
