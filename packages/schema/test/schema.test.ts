import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Actor,
  EVENT_TYPES,
  HandoffPacket,
  Message,
  NewEvent,
  PlanGraph,
  Review,
  TASK_TYPES,
  TaskContract,
  taskGroup,
  Workspace,
} from "../src/index";

const docs = resolve(import.meta.dirname, "../../../docs");
const read = (f: string) => readFileSync(resolve(docs, f), "utf8");

const uuid = "0192b3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b";
const contract = {
  objective: "Add a health endpoint",
  inputs: [{ kind: "file", ref: "apps/api/src/server.ts" }],
  outputs: [{ kind: "diff", description: "the endpoint and its test" }],
  acceptance: [{ kind: "tests", command: "pnpm test" }],
  constraints: [],
  sensitivity: "internal",
};

describe("docs stay in sync with the schemas", () => {
  it("packet #0 in HANDOFF_PACKET.md is a valid HandoffPacket", () => {
    const doc = read("HANDOFF_PACKET.md");
    const json = doc.slice(doc.indexOf("```json") + 7, doc.indexOf("```", doc.indexOf("```json") + 7));
    expect(HandoffPacket.safeParse(JSON.parse(json)).error).toBeUndefined();
  });

  it("the task taxonomy matches ROUTING_AND_QUALITY.md §1", () => {
    const doc = read("ROUTING_AND_QUALITY.md");
    const table = doc.slice(doc.indexOf("## 1. Task taxonomy"), doc.indexOf("## 2."));
    const documented = [...table.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]);
    expect([...TASK_TYPES].sort()).toEqual([...new Set(documented)].sort());
  });

  it("every event type in ARCHITECTURE.md §3 is known", () => {
    const doc = read("ARCHITECTURE.md");
    const line = doc.split("\n").find((l) => l.startsWith("Event types (initial)")) ?? "";
    const documented = [...line.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1]);
    expect([...EVENT_TYPES].sort()).toEqual(documented.sort());
  });
});

describe("TaskContract", () => {
  it("accepts a complete contract and defaults checks to hard", () => {
    const parsed = TaskContract.parse(contract);
    expect(parsed.acceptance[0]?.hard).toBe(true);
  });
  it("rejects a contract without acceptance checks (rule 4)", () => {
    expect(TaskContract.safeParse({ ...contract, acceptance: [] }).success).toBe(false);
  });
  it("rejects a contract without outputs", () => {
    expect(TaskContract.safeParse({ ...contract, outputs: [] }).success).toBe(false);
  });
});

describe("PlanGraph", () => {
  const task = {
    key: "api.health",
    type: "code.feature",
    title: "Health endpoint",
    contract,
    dependsOn: [],
    suggestedMode: "single",
  };
  it("accepts a one-task plan", () => {
    expect(PlanGraph.safeParse({ tasks: [task], assumptions: [], questions: [] }).success).toBe(true);
  });
  it("rejects unknown task types and more than three questions", () => {
    expect(
      PlanGraph.safeParse({ tasks: [{ ...task, type: "code.magic" }], assumptions: [], questions: [] })
        .success,
    ).toBe(false);
    expect(
      PlanGraph.safeParse({ tasks: [task], assumptions: [], questions: ["a", "b", "c", "d"] }).success,
    ).toBe(false);
  });
});

describe("Actor", () => {
  it.each(["system", "user:abc", `agent:${uuid}`])("accepts %s", (a) =>
    expect(Actor.safeParse(a).success).toBe(true),
  );
  it.each(["root", "user:", "agent", ""])("rejects %s", (a) =>
    expect(Actor.safeParse(a).success).toBe(false),
  );
});

describe("refinements", () => {
  const base = { id: uuid, workspaceId: uuid, createdAt: new Date(), updatedAt: new Date() };
  it("a message has exactly one recipient", () => {
    const m = { ...base, missionId: uuid, fromAttemptId: null, kind: "question", body: "?", status: "open" };
    expect(Message.safeParse({ ...m, toTaskId: uuid, toAttemptId: null, toUser: false }).success).toBe(true);
    expect(Message.safeParse({ ...m, toTaskId: uuid, toAttemptId: null, toUser: true }).success).toBe(false);
    expect(Message.safeParse({ ...m, toTaskId: null, toAttemptId: null, toUser: false }).success).toBe(false);
  });
  it("a review has exactly one reviewer", () => {
    const r = {
      ...base,
      taskId: uuid,
      attemptId: null,
      kind: "review",
      verdict: "pass",
      scores: {},
      reasons: "",
      evidence: [],
    };
    expect(Review.safeParse({ ...r, reviewerAgentId: uuid, reviewerUserId: null }).success).toBe(true);
    expect(Review.safeParse({ ...r, reviewerAgentId: uuid, reviewerUserId: uuid }).success).toBe(false);
  });
});

describe("misc", () => {
  it("workspace slugs are lowercase slugs", () => {
    const w = {
      id: uuid,
      name: "Acme",
      plan: "free",
      settings: {},
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: new Date(),
      deletedAt: null,
    };
    expect(Workspace.safeParse({ ...w, slug: "acme-labs" }).success).toBe(true);
    expect(Workspace.safeParse({ ...w, slug: "Acme Labs" }).success).toBe(false);
  });
  it("NewEvent defaults task and attempt to null", () => {
    const e = NewEvent.parse({
      workspaceId: uuid,
      missionId: uuid,
      type: "mission.created",
      actor: "system",
      payload: {},
    });
    expect(e).toMatchObject({ taskId: null, attemptId: null });
  });
  it("taskGroup splits the type", () => {
    expect(taskGroup("research.deep_report")).toBe("research");
  });
});
