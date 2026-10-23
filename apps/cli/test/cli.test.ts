import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { type BoardMission, eventLine, renderBoard } from "../src/board";
import { parseSse } from "../src/client";
import { configPath, loadConfig, saveConfig } from "../src/config";

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });

describe("brio CLI", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("parses positionals, flags, values and repeated options", () => {
    const a = parseArgs([
      "run",
      "Add",
      "auth",
      "--budget",
      "5",
      "--quick",
      "--file",
      "a.md",
      "--file=b.png",
      "--as-is",
    ]);
    expect(a._).toEqual(["run", "Add", "auth"]);
    expect(a.flags).toMatchObject({ budget: "5", quick: true, file: "b.png", "as-is": true });
    expect(a.all.file).toEqual(["a.md", "b.png"]);
  });

  it("reads server-sent events split anywhere, skipping comments and retry lines", async () => {
    const events = [];
    for await (const e of parseSse(
      stream([
        "retry: 2000\n\n: keepalive\n\nid: 1\nevent: mission.cre",
        'ated\ndata: {"seq":1,"type":"mission.created","payload":{}}\n\nid: 2\r\nevent: plan.proposed\r\ndata: {"seq":2}\r\n\r\n',
      ]),
    ))
      events.push(e);
    expect(events).toEqual([
      { id: 1, type: "mission.created", data: { seq: 1, type: "mission.created", payload: {} } },
      { id: 2, type: "plan.proposed", data: { seq: 2 } },
    ]);
  });

  it("renders the board: tasks with agents and cost, what waits for you, recent events", () => {
    const m: BoardMission = {
      mission: {
        id: "0199aaaa-0000-7000-8000-000000000000",
        title: "Add auth",
        status: "awaiting_approval",
        blockedReason: null,
        budget: { usd: 2 },
      },
      plan: { version: 1, status: "proposed" },
      tasks: [
        {
          key: "api",
          title: "Build the API",
          status: "done",
          planVersion: 1,
          attempts: [{ agentId: "a1", status: "succeeded", costUsd: 0.25, role: "maker" }],
        },
        { key: "web", title: "Build the page", status: "running", planVersion: 1, attempts: [] },
      ],
      deliveries: [
        { kind: "pull_request", status: "awaiting_approval", url: null, branch: "brio/add-auth-0199aaaa" },
      ],
    };
    const text = renderBoard(
      m,
      [{ seq: 7, type: "task.done", ts: "", payload: { taskKey: "api", agent: "claude" } }],
      { color: false, width: 100, agents: new Map([["a1", "claude"]]) },
    );
    expect(text).toContain("Add auth  awaiting_approval  $0.2500 of $2.00");
    expect(text).toContain("plan v1 waits for approval: brio approve 0199aaaa");
    expect(text).toContain("pull request brio/add-auth-0199aaaa waits for approval");
    expect(text).toMatch(/api\s+done\s+claude\s+Build the API\s+\$0\.2500/);
    expect(text).toMatch(/web\s+running\s+–/);
    expect(text).toContain("   7 task.done · api · claude");
    expect(text).not.toContain("\x1b[");
    expect(renderBoard(m, [], { color: true, width: 100 })).toContain("\x1b[");
    expect(eventLine({ seq: 3, type: "attempt.cost", ts: "", payload: { usd: 0.0042 } })).toBe(
      "   3 attempt.cost · $0.0042",
    );
  });

  it("keeps its session in a file only its user can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brio-cli-"));
    dirs.push(dir);
    expect(configPath({ XDG_CONFIG_HOME: dir })).toBe(join(dir, "brio", "config.json"));
    expect(configPath({ BRIO_CONFIG: "/x/y.json" })).toBe("/x/y.json");
    const path = configPath({ XDG_CONFIG_HOME: dir });
    expect(await loadConfig(path)).toBeNull();
    await saveConfig(path, {
      url: "https://b.example",
      session: "s3ss10n",
      email: "a@b.c",
      workspaceId: null,
      workspaceName: null,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadConfig(path)).toMatchObject({ url: "https://b.example", session: "s3ss10n" });
  });
});
