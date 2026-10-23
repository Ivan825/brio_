// The mission report (BUILD_PLAN M5): what was done, by whom, with what evidence, at what cost and time, and what is
// still open. Pure: the API gathers the rows, this shapes them, and renders the Markdown a person reads.

export interface ReportCheck {
  kind: string;
  hard: boolean;
  status: string;
  summary?: string;
}

export interface ReportTask {
  key: string;
  title: string;
  type: string;
  status: string;
  /** The agent whose result stands, and its vendor. */
  agent: string | null;
  vendor: string | null;
  mode: string;
  rationale: string | null;
  note: string | null;
  revisions: number;
  reroutes: number;
  carried: boolean;
  costUsd: number;
  seconds: number;
  checks: ReportCheck[];
  blockedReason: string | null;
}

export interface ReportAttempt {
  agent: string;
  vendor: string;
  costUsd: number;
  seconds: number;
  /** pass, revise or fail once scored; null for reviewers, judges and unfinished work. */
  scored: string | null;
  role: string;
}

export interface ReportInput {
  mission: {
    title: string;
    goal: string;
    status: string;
    budgetUsd?: number;
    createdAt: Date;
    endedAt: Date | null;
  };
  tasks: ReportTask[];
  attempts: ReportAttempt[];
  integration: {
    status: string;
    branch: string | null;
    commit: string | null;
    round: number;
    conflicts: Array<{ between: [string, string]; files: string[] }>;
    checks: Array<{ command: string; passed: boolean }>;
  } | null;
  assumptions: string[];
  /** Questions to a person nobody answered. */
  unanswered: string[];
  replans: number;
}

export interface OpenIssue {
  kind: "failed_task" | "soft_check" | "unanswered" | "integration" | "budget" | "assumption" | "blocked";
  task?: string;
  text: string;
}

export interface MissionReport {
  title: string;
  goal: string;
  status: string;
  costUsd: number;
  budgetUsd: number | null;
  minutes: number;
  attempts: number;
  tasks: ReportTask[];
  agents: Array<{ agent: string; vendor: string; attempts: number; passed: number; costUsd: number }>;
  integration: ReportInput["integration"];
  openIssues: OpenIssue[];
  replans: number;
}

const round2 = (n: number) => Math.round(n * 1e6) / 1e6;

export function buildMissionReport(i: ReportInput, now = new Date()): MissionReport {
  const costUsd = round2(i.attempts.reduce((s, a) => s + a.costUsd, 0));
  const agents = new Map<
    string,
    { agent: string; vendor: string; attempts: number; passed: number; costUsd: number }
  >();
  for (const a of i.attempts) {
    const row = agents.get(a.agent) ?? {
      agent: a.agent,
      vendor: a.vendor,
      attempts: 0,
      passed: 0,
      costUsd: 0,
    };
    row.attempts++;
    if (a.scored === "pass") row.passed++;
    row.costUsd = round2(row.costUsd + a.costUsd);
    agents.set(a.agent, row);
  }
  const issues: OpenIssue[] = [];
  for (const t of i.tasks) {
    if (t.status === "failed")
      issues.push({
        kind: "failed_task",
        task: t.key,
        text: `${t.title} failed${t.blockedReason ? `: ${t.blockedReason}` : ""}`,
      });
    if (t.status === "blocked")
      issues.push({
        kind: "blocked",
        task: t.key,
        text: `${t.title} is blocked${t.blockedReason ? `: ${t.blockedReason}` : ""}`,
      });
    for (const c of t.checks)
      if (!c.hard && c.status === "failed")
        issues.push({
          kind: "soft_check",
          task: t.key,
          text: `${c.kind} did not pass${c.summary ? `: ${c.summary}` : ""}`,
        });
  }
  for (const q of i.unanswered) issues.push({ kind: "unanswered", text: q });
  if (i.integration && i.integration.status !== "passed")
    issues.push({
      kind: "integration",
      text:
        i.integration.status === "conflict"
          ? `the branches conflict in ${i.integration.conflicts.flatMap((c) => c.files).join(", ")}`
          : `the merged work fails: ${
              i.integration.checks
                .filter((c) => !c.passed)
                .map((c) => c.command)
                .join(", ") || i.integration.status
            }`,
    });
  if (i.mission.budgetUsd !== undefined && costUsd > i.mission.budgetUsd)
    issues.push({
      kind: "budget",
      text: `spent $${costUsd.toFixed(2)} of a $${i.mission.budgetUsd.toFixed(2)} budget`,
    });
  for (const a of i.assumptions) issues.push({ kind: "assumption", text: `assumed: ${a}` });

  const end = i.mission.endedAt ?? now;
  return {
    title: i.mission.title,
    goal: i.mission.goal,
    status: i.mission.status,
    costUsd,
    budgetUsd: i.mission.budgetUsd ?? null,
    minutes: Math.round((end.getTime() - i.mission.createdAt.getTime()) / 6000) / 10,
    attempts: i.attempts.length,
    tasks: i.tasks,
    agents: [...agents.values()].sort((a, b) => b.costUsd - a.costUsd || a.agent.localeCompare(b.agent)),
    integration: i.integration,
    openIssues: issues,
    replans: i.replans,
  };
}

const money = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The report as Markdown, for people (and for the artifact stored with the mission). */
export function renderMissionReport(r: MissionReport): string {
  const lines = [
    `# ${r.title}`,
    "",
    `**Goal:** ${r.goal}`,
    "",
    `**Status:** ${r.status} · **cost** ${money(r.costUsd)}${r.budgetUsd !== null ? ` of ${money(r.budgetUsd)}` : ""} · **time** ${r.minutes} min · **attempts** ${r.attempts}${r.replans ? ` · **replans** ${r.replans}` : ""}`,
    "",
    "## What was done",
    "",
    "| Task | Status | Who | How | Checks | Cost |",
    "|---|---|---|---|---|---|",
    ...r.tasks.map(
      (t) =>
        `| ${cell(`${t.title} (\`${t.key}\`)`)} | ${t.status}${t.revisions ? `, ${t.revisions} revision(s)` : ""}${t.reroutes ? ", rerouted" : ""}${t.carried ? ", carried over" : ""} | ${cell(t.agent ?? "–")}${t.vendor ? ` (${t.vendor})` : ""} | ${cell(t.mode.replaceAll("_", " "))}${t.note ? `: ${cell(t.note)}` : ""} | ${t.checks.map((c) => `${c.kind} ${c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "…"}`).join(", ") || "–"} | ${money(t.costUsd)} |`,
    ),
  ];
  if (r.agents.length)
    lines.push(
      "",
      "## Who did it",
      "",
      "| Agent | Vendor | Attempts | Passed | Cost |",
      "|---|---|---|---|---|",
      ...r.agents.map(
        (a) => `| ${cell(a.agent)} | ${a.vendor} | ${a.attempts} | ${a.passed} | ${money(a.costUsd)} |`,
      ),
    );
  const evidence = r.tasks.flatMap((t) =>
    t.checks.filter((c) => c.summary).map((c) => `- \`${t.key}\` ${c.kind} ${c.status}: ${c.summary}`),
  );
  if (evidence.length) lines.push("", "## Evidence", "", ...evidence);
  if (r.integration)
    lines.push(
      "",
      "## Integration",
      "",
      `Round ${r.integration.round}: ${r.integration.status}${r.integration.branch ? ` on \`${r.integration.branch}\`` : ""}${r.integration.commit ? ` at \`${r.integration.commit.slice(0, 12)}\`` : ""}.`,
      ...r.integration.checks.map((c) => `- \`${c.command}\` ${c.passed ? "passed" : "failed"}`),
    );
  lines.push("", "## Open issues", "");
  if (!r.openIssues.length) lines.push("None.");
  else lines.push(...r.openIssues.map((o) => `- ${o.task ? `\`${o.task}\` ` : ""}${o.text}`));
  return `${lines.join("\n")}\n`;
}
