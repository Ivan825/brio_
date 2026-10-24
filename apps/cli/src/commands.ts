// The brio CLI's commands (BUILD_PLAN M8): login, logout, whoami, workspace, missions, run, plan, board, approve. Each
// takes the parsed arguments and an Io (where to write, how to fetch, where the config lives), so tests drive them
// against a real API.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { type Args, str } from "./args";
import { followBoard } from "./board";
import { BrioClient, BrioError } from "./client";
import { type CliConfig, loadConfig, removeConfig, saveConfig } from "./config";

export const CLI_CLIENT_ID = "brio-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  configPath: string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  tty: boolean;
  color: boolean;
  width: () => number;
}

export class UsageError extends Error {}

const sleepOf = (io: Io) => io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

async function signedIn(io: Io): Promise<{ config: CliConfig; client: BrioClient }> {
  const config = await loadConfig(io.configPath);
  if (!config) throw new UsageError("not signed in: run `brio login` first");
  const client = new BrioClient({
    url: config.url,
    session: config.session,
    workspaceId: config.workspaceId,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  return { config, client };
}

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  active?: boolean;
}

const pickWorkspace = (list: Workspace[], want?: string) =>
  want
    ? list.find((w) => w.id === want || w.slug === want || w.name.toLowerCase() === want.toLowerCase())
    : (list.find((w) => w.active) ?? list[0]);

/** `brio login [--url URL] [--workspace slug]`: the device flow; the person approves the code in the browser. */
export async function login(a: Args, io: Io): Promise<void> {
  const url = (
    str(a, "url") ??
    io.env.BRIO_URL ??
    (await loadConfig(io.configPath))?.url ??
    "http://localhost:3000"
  ).replace(/\/+$/, "");
  const anon = new BrioClient({ url, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const start = await anon.post<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }>("/api/auth/device/code", { client_id: CLI_CLIENT_ID });
  const shown = start.user_code.replace(/^(.{4})(.+)$/, "$1-$2");
  io.out(
    `Open ${start.verification_uri_complete}\nand confirm the code ${shown} (it expires in ${Math.round(start.expires_in / 60)} minutes).\n`,
  );
  let interval = start.interval * 1000;
  const until = Date.now() + start.expires_in * 1000;
  let session = "";
  while (!session) {
    if (Date.now() > until)
      throw new Error("the code expired before it was approved; run `brio login` again");
    await sleepOf(io)(interval);
    try {
      const t = await anon.post<{ access_token: string }>("/api/auth/device/token", {
        grant_type: DEVICE_GRANT,
        device_code: start.device_code,
        client_id: CLI_CLIENT_ID,
      });
      session = t.access_token;
    } catch (e) {
      const code = e instanceof BrioError ? e.code : undefined;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (code === "access_denied") throw new Error("the code was denied in the browser");
      if (code === "expired_token") throw new Error("the code expired; run `brio login` again");
      throw e;
    }
  }
  const client = new BrioClient({ url, session, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const me = await client.get<{ user: { email: string } } | null>("/api/auth/get-session");
  const { workspaces } = await client.get<{ workspaces: Workspace[] }>("/v1/workspaces");
  const ws = pickWorkspace(workspaces, str(a, "workspace"));
  await saveConfig(io.configPath, {
    url,
    session,
    email: me?.user.email ?? "",
    workspaceId: ws?.id ?? null,
    workspaceName: ws?.name ?? null,
  });
  io.out(
    `Signed in as ${me?.user.email ?? "you"}${ws ? ` · workspace ${ws.name}` : " · no workspace yet (create one in the web app)"}\n`,
  );
}

/** `brio logout`: ends the CLI's session on the server and forgets it here. */
export async function logout(_a: Args, io: Io): Promise<void> {
  const config = await loadConfig(io.configPath);
  if (config) {
    const client = new BrioClient({
      url: config.url,
      session: config.session,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    await client.post("/api/auth/sign-out").catch(() => {});
  }
  await removeConfig(io.configPath);
  io.out("Signed out.\n");
}

export async function whoami(_a: Args, io: Io): Promise<void> {
  const { config } = await signedIn(io);
  io.out(
    `${config.email} at ${config.url}${config.workspaceName ? ` · workspace ${config.workspaceName}` : ""}\n`,
  );
}

/** `brio workspace` lists them; `brio workspace use <slug|name|id>` switches. */
export async function workspace(a: Args, io: Io): Promise<void> {
  const { config, client } = await signedIn(io);
  const { workspaces } = await client.get<{ workspaces: Workspace[] }>("/v1/workspaces");
  if (a._[1] === "use") {
    const ws = pickWorkspace(workspaces, a._[2]);
    if (!a._[2] || !ws) throw new UsageError(`no workspace ${a._[2] ?? ""}: brio workspace lists them`);
    await saveConfig(io.configPath, { ...config, workspaceId: ws.id, workspaceName: ws.name });
    io.out(`Using ${ws.name}\n`);
    return;
  }
  for (const w of workspaces)
    io.out(`${w.id === config.workspaceId ? "*" : " "} ${w.slug.padEnd(24)} ${w.name} (${w.role})\n`);
}

interface MissionRow {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

/** A mission by id or id prefix (as the board and `brio missions` show them). */
async function resolveMission(client: BrioClient, ref: string | undefined): Promise<string> {
  if (!ref) throw new UsageError("which mission? give its id (or the first characters of it)");
  if (/^[0-9a-f-]{36}$/.test(ref)) return ref;
  const { missions } = await client.get<{ missions: MissionRow[] }>("/v1/missions");
  const hits = missions.filter((m) => m.id.startsWith(ref));
  if (hits.length === 1) return (hits[0] as MissionRow).id;
  throw new UsageError(
    hits.length ? `${ref} matches ${hits.length} missions; give more of the id` : `no mission ${ref}`,
  );
}

/** Something by id, exact name or slug in a list. */
function byName<T extends { id: string; name: string }>(list: T[], ref: string, what: string): T {
  const hit = list.find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new UsageError(`no ${what} ${ref}`);
  return hit;
}

export async function missions(_a: Args, io: Io): Promise<void> {
  const { client } = await signedIn(io);
  const { missions: list } = await client.get<{ missions: MissionRow[] }>("/v1/missions");
  if (!list.length) io.out('No missions yet. Start one: brio run "your goal"\n');
  for (const m of list) io.out(`${m.id.slice(0, 8)}  ${m.status.padEnd(18)} ${m.title}\n`);
}

/**
 * `brio run "<goal>" [--project p] [--priority quality|balanced|cheap|fast] [--budget usd] [--minutes m]
 * [--crew c | --agent a] [--planner a] [--template t [--as-is]] [--issue url] [--file path]… [--quick] [--watch]`
 */
export async function run(a: Args, io: Io): Promise<void> {
  const goal = a._.slice(1).join(" ").trim();
  if (!goal) throw new UsageError('brio run "<goal>": say what the mission is');
  const { config, client } = await signedIn(io);
  const body: Record<string, unknown> = { goal };
  const priority = str(a, "priority");
  if (priority) body.priority = priority;
  const usdBudget = Number(str(a, "budget") ?? 0);
  const minutes = Number(str(a, "minutes") ?? 0);
  if (usdBudget > 0 || minutes > 0)
    body.budget = { ...(usdBudget > 0 ? { usd: usdBudget } : {}), ...(minutes > 0 ? { minutes } : {}) };
  if (a.flags.quick) body.autoApprove = true;
  const project = str(a, "project");
  if (project) {
    const { projects } = await client.get<{ projects: Array<{ id: string; name: string }> }>("/v1/projects");
    body.projectId = byName(projects, project, "project").id;
  }
  const crew = str(a, "crew");
  const agent = str(a, "agent");
  const planner = str(a, "planner");
  if (crew) {
    const { crews } = await client.get<{ crews: Array<{ id: string; name: string }> }>("/v1/crews");
    body.routing = { strategy: "crew", crewId: byName(crews, crew, "crew").id };
  }
  if (agent || planner) {
    const { agents } = await client.get<{ agents: Array<{ id: string; name: string }> }>("/v1/agents");
    if (agent) body.routing = { strategy: "single", agentId: byName(agents, agent, "agent").id };
    if (planner) body.plannerAgentId = byName(agents, planner, "agent").id;
  }
  const template = str(a, "template");
  if (template) {
    const { templates } = await client.get<{ templates: Array<{ id: string; name: string }> }>(
      "/v1/templates",
    );
    body.template = {
      id: byName(templates, template, "template").id,
      mode: a.flags["as-is"] ? "as_is" : "adapt",
    };
  }
  const issue = str(a, "issue");
  if (issue) body.issueUrl = issue;
  const files = a.all.file ?? [];
  if (files.length)
    body.files = await Promise.all(
      files.map(async (path) => {
        const bytes = await readFile(path);
        const text = !bytes.includes(0) && Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
        return text
          ? { name: basename(path), content: bytes.toString("utf8") }
          : { name: basename(path), content: bytes.toString("base64"), encoding: "base64" };
      }),
    );
  const { mission } = await client.post<{ mission: { id: string; status: string } }>("/v1/missions", body);
  io.out(`Mission ${mission.id.slice(0, 8)} · ${mission.status}\n${config.url}/missions/${mission.id}\n`);
  if (a.flags.watch)
    await followBoard(client, mission.id, { write: io.out, tty: io.tty, color: io.color, width: io.width });
}

interface PlanTask {
  key: string;
  type: string;
  title: string;
  dependsOn: string[];
  suggestedMode: string;
  pinnedAgentId?: string;
  estimate?: { usd: number; minutes: number };
  contract: { acceptance: Array<{ kind: string }> };
}

interface MissionView {
  mission: { id: string; title: string; status: string };
  plan: {
    version: number;
    status: string;
    graph: { tasks: PlanTask[]; assumptions: string[]; questions: string[] };
    lint: {
      errors?: Array<{ task?: string; message: string }>;
      estimate?: { usd: number; minutes: number } | null;
    };
  } | null;
}

/**
 * `brio plan <mission>` shows the plan; edits make a new version: `--pin key=agent`, `--remove key`, `--gate key`,
 * `--ungate key`, `--after key=other`, `--mode key=best_of_n`, `--move key=before-key`. `--json` prints it raw.
 */
export async function plan(a: Args, io: Io): Promise<void> {
  const { client } = await signedIn(io);
  const id = await resolveMission(client, a._[1]);
  let view = await client.get<MissionView>(`/v1/missions/${id}`);
  if (!view.plan) throw new UsageError("this mission has no plan yet: the planner is still working");
  const pairs = (k: string) =>
    (a.all[k] ?? []).map((v) => {
      const at = v.indexOf("=");
      if (at < 1) throw new UsageError(`--${k} takes key=value`);
      return [v.slice(0, at), v.slice(at + 1)] as const;
    });
  const edits: Array<Record<string, unknown>> = [];
  if (a.all.pin?.length) {
    const { agents } = await client.get<{ agents: Array<{ id: string; name: string }> }>("/v1/agents");
    for (const [key, who] of pairs("pin"))
      edits.push({ op: "pin", key, agentId: who === "-" ? null : byName(agents, who, "agent").id });
  }
  for (const key of a.all.remove ?? []) edits.push({ op: "remove", key });
  for (const key of a.all.gate ?? []) edits.push({ op: "gate", key, on: true });
  for (const key of a.all.ungate ?? []) edits.push({ op: "gate", key, on: false });
  for (const [key, on] of pairs("after")) edits.push({ op: "depend", key, on });
  for (const [key, mode] of pairs("mode")) edits.push({ op: "mode", key, mode });
  for (const [key, before] of pairs("move")) edits.push({ op: "move", key, before: before || null });
  if (edits.length) {
    await client.post(`/v1/missions/${id}/plans/${view.plan.version}/edits`, { edits });
    view = await client.get<MissionView>(`/v1/missions/${id}`);
  }
  if (a.flags.json) {
    io.out(`${JSON.stringify(view.plan, null, 2)}\n`);
    return;
  }
  const p = view.plan as NonNullable<MissionView["plan"]>;
  io.out(
    `${view.mission.title} · plan v${p.version} (${p.status})${p.lint.estimate ? ` · ~$${p.lint.estimate.usd.toFixed(2)}, ${p.lint.estimate.minutes} min` : ""}\n`,
  );
  for (const t of p.graph.tasks) {
    const gate = t.contract.acceptance.some((x) => x.kind === "human") ? " [approval gate]" : "";
    const mode = t.suggestedMode !== "single" ? ` [${t.suggestedMode}]` : "";
    io.out(
      `  ${t.key}  ${t.type}  ${t.title}${mode}${gate}${t.dependsOn.length ? `  (after ${t.dependsOn.join(", ")})` : ""}\n`,
    );
  }
  for (const e of p.lint.errors ?? []) io.out(`  error: ${e.task ? `${e.task}: ` : ""}${e.message}\n`);
  for (const q of p.graph.questions) io.out(`  question: ${q}\n`);
  if (p.status === "proposed") io.out(`Approve it: brio approve ${id.slice(0, 8)}\n`);
}

/** `brio board <mission> [--once]`: the live board in the terminal. */
export async function board(a: Args, io: Io): Promise<void> {
  const { client } = await signedIn(io);
  const id = await resolveMission(client, a._[1]);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  try {
    const status = await followBoard(
      client,
      id,
      { write: io.out, tty: io.tty, color: io.color, width: io.width },
      { once: Boolean(a.flags.once), signal: abort.signal },
    );
    if (!a.flags.once) io.out(`Mission ${status}.\n`);
  } finally {
    process.off("SIGINT", stop);
  }
}

interface InboxItem {
  kind: string;
  missionId: string | null;
  mission: string | null;
  version?: number;
  approvalId?: string;
  action?: string;
  messageId?: string;
  body?: string;
  taskId?: string;
  taskKey?: string;
  title?: string;
}

const describe = (i: InboxItem) => {
  const m = i.missionId ? `${i.missionId.slice(0, 8)} ${i.mission ?? ""}` : "";
  switch (i.kind) {
    case "plan":
      return `plan v${i.version} to approve · ${m}`;
    case "action":
      return `${(i.action ?? "").replaceAll("_", " ")} · ${m} · approval ${i.approvalId?.slice(0, 8)}`;
    case "review":
      return `result to review: ${i.taskKey} ${i.title ?? ""} · ${m}`;
    default:
      return `${i.kind.replace("_", " ")}: ${i.body ?? ""} · ${m}`;
  }
};

/**
 * `brio approve` lists what waits for you. `brio approve <mission>` approves its proposed plan, or the action waiting
 * on it (a pull request); `brio approve <approval-id>` decides that one. `--deny [--reason r]` says no instead.
 */
export async function approve(a: Args, io: Io): Promise<void> {
  const { client } = await signedIn(io);
  const { items } = await client.get<{ items: InboxItem[] }>("/v1/inbox");
  const ref = a._[1];
  if (!ref) {
    if (!items.length) io.out("Nothing is waiting for you.\n");
    for (const i of items) io.out(`- ${describe(i)}\n`);
    return;
  }
  const deny = Boolean(a.flags.deny);
  const reason = str(a, "reason");
  const action = items.find((i) => i.kind === "action" && i.approvalId?.startsWith(ref));
  const forMission = items.filter((i) => i.missionId?.startsWith(ref));
  const target =
    action ?? forMission.find((i) => i.kind === "plan") ?? forMission.find((i) => i.kind === "action");
  if (!target)
    throw new UsageError(
      forMission.length
        ? `${ref} waits on ${forMission.map((i) => i.kind).join(", ")}: answer questions and reviews on the board`
        : `nothing for ${ref} waits for approval`,
    );
  if (target.kind === "plan") {
    if (deny) throw new UsageError("to change a plan, edit it (brio plan) or ask for another on the board");
    await client.post(`/v1/missions/${target.missionId}/plans/${target.version}/approve`);
    io.out(
      `Approved plan v${target.version} of ${target.mission}. It is running: brio board ${target.missionId?.slice(0, 8)}\n`,
    );
    return;
  }
  const r = await client.post<{ approval: { status: string }; delivery: { status: string } | null }>(
    `/v1/approvals/${target.approvalId}/decide`,
    { decision: deny ? "deny" : "approve", ...(reason ? { reason } : {}) },
  );
  io.out(
    `${r.approval.status === "approved" ? "Approved" : "Denied"}: ${(target.action ?? "").replaceAll("_", " ")} for ${target.mission}${r.delivery?.status === "queued" ? " — a runner is pushing it now" : ""}.\n`,
  );
}

export const USAGE = `brio — run missions across your agents

  brio login [--url https://brio.example] [--workspace slug]
  brio logout | whoami
  brio workspace [use <slug>]
  brio missions
  brio run "<goal>" [--project p] [--priority quality|balanced|cheap|fast] [--budget usd] [--minutes m]
                    [--crew c | --agent a] [--planner a] [--template t [--as-is]] [--issue url]
                    [--file path]… [--quick] [--watch]
  brio plan <mission> [--pin key=agent] [--remove key] [--gate key] [--after key=other] [--mode key=mode]
                      [--move key=before] [--json]
  brio board <mission> [--once]
  brio approve [<mission>|<approval>] [--deny] [--reason r]
  brio runner register --name laptop [--host [--yes]]
  brio runner start [--api https://api.brio.example] [--dir path]
  brio runner status
  brio mcp                       Brio's MCP tools over stdio (BRIO_URL, BRIO_TOKEN)
  brio --version
`;

export const COMMANDS: Record<string, (a: Args, io: Io) => Promise<void>> = {
  login,
  logout,
  whoami,
  workspace,
  missions,
  run,
  plan,
  board,
  approve,
};
