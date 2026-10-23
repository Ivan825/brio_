// M7 acceptance: an external A2A client (the official @a2a-js/sdk, v1.0) discovers Brio from its Agent Card, sends it
// a mission, follows it over SSE and receives the report as an artifact; the task survives as a stored A2A task, held
// to the caller's workspace. Needs Postgres.
import { Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { hasTestDatabase } from "@brio/db/testing";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_URL, Client, type Harness, startHarness } from "./helpers";
import { type Reply, ScriptedVendors, taskTitle } from "./vendors";

const doc = (key: string, title: string) => ({
  key,
  type: "write.summary",
  title,
  contract: {
    objective: title,
    inputs: [],
    outputs: [{ kind: "doc", description: title }],
    acceptance: [{ kind: "diff_scope", hard: true }],
    constraints: [],
    sensitivity: "internal",
  },
  dependsOn: [],
  suggestedMode: "single",
});
const PLAN = { tasks: [doc("brief", "Write the launch brief")], assumptions: [], questions: [] };

function script(call: { model: string; body: string }): Reply {
  if (call.model === "planner") return { text: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`` };
  if (taskTitle(call.body) === "Write the launch brief")
    return { text: "Launch brief: ship Brio on Monday." };
  return { text: "?" };
}

const message = (text: string) => ({
  messageId: uuidv7(),
  contextId: "",
  taskId: "",
  role: Role.ROLE_USER,
  parts: [
    {
      content: { $case: "text" as const, value: text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

describe.skipIf(!hasTestDatabase)("M7: Brio as an A2A agent", () => {
  const vendors = new ScriptedVendors(script);
  let h: Harness;
  let c: Client;
  let base: string;
  let token: string;

  /** The card names APP_URL; route it to the test server, with the caller's token. */
  const factoryFor = (bearer: string | null) => {
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input).replace(APP_URL, base);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (bearer) headers.set("authorization", `Bearer ${bearer}`);
      return fetch(url, {
        ...init,
        headers,
        ...(input instanceof Request && !init
          ? { method: input.method, body: input.body, duplex: "half" }
          : {}),
      } as RequestInit);
    };
    return new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
        cardResolver: undefined,
      }),
    );
  };

  beforeAll(async () => {
    h = await startHarness({ fetch: vendors.fetch });
    c = new Client(h);
    await c.signIn("a2a@example.com");
    await c.request("POST", "/v1/workspaces", { name: "A2A" });
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const openai = (
      await c.request("POST", "/v1/connectors", {
        registryKey: "openai-api",
        apiKey: ["sk", "a2a0123456789abcdefghij"].join("-"),
      })
    ).json().connector;
    await c.request("POST", "/v1/agents", {
      connectorId: openai.id,
      name: "planner",
      model: "planner",
      priceOverride: price,
    });
    token = (await c.request("POST", "/v1/tokens", { name: "partner agent" })).json().token.value;
    base = await h.server.app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => h?.close());

  it("publishes an A2A v1.0 Agent Card", async () => {
    const card = (await c.request("GET", "/.well-known/agent-card.json")).json();
    expect(card).toMatchObject({
      name: "Brio",
      supportedInterfaces: [{ url: `${APP_URL}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: true },
    });
    expect(card.skills.map((s: { id: string }) => s.id)).toContain("run_mission");
    expect(card.securitySchemes.brioToken.httpAuthSecurityScheme.scheme).toBe("Bearer");
  });

  it("takes a mission from an A2A client, streams progress and returns the report as an artifact", async () => {
    const client = await factoryFor(token).createFromUrl(base);
    const states: number[] = [];
    let taskId = "";
    for await (const ev of client.sendMessageStream({
      tenant: "",
      message: message("Write a short launch brief for Brio"),
      configuration: undefined,
      metadata: undefined,
    })) {
      const p = (ev as { payload?: { $case: string; value: Record<string, unknown> } }).payload;
      if (p?.$case === "task") taskId = String(p.value.id);
      if (p?.$case === "statusUpdate") states.push((p.value.status as { state: number }).state);
    }
    expect(states.at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(states).toContain(TaskState.TASK_STATE_WORKING);
    const task = await client.getTask({ tenant: "", id: taskId, historyLength: undefined });
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const report = task.artifacts.find((a) => a.name === "report.md");
    const body = report?.parts[0]?.content;
    expect(body?.$case).toBe("text");
    expect(String(body?.value)).toContain("brief");
    expect(task.metadata?.missionId).toBeTruthy();
  }, 120_000);

  it("waits for the result on a blocking SendMessage", async () => {
    const client = await factoryFor(token).createFromUrl(base);
    const r = (await client.sendMessage({
      tenant: "",
      message: message("Write another launch brief"),
      configuration: undefined,
      metadata: undefined,
    })) as { status?: { state: number }; artifacts?: unknown[] };
    expect(r.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(r.artifacts?.length).toBeGreaterThan(0);
  }, 120_000);

  it("refuses callers without a token, and keeps tasks to their workspace", async () => {
    const anonymous = await factoryFor(null).createFromUrl(base);
    await expect(
      anonymous.sendMessage({
        tenant: "",
        message: message("hello"),
        configuration: undefined,
        metadata: undefined,
      }),
    ).rejects.toThrow();
    await c.request("POST", "/v1/workspaces", { name: "Other" });
    const other = (await c.request("POST", "/v1/tokens", { name: "other" })).json().token.value;
    const mine = await factoryFor(token).createFromUrl(base);
    const listed = await mine.listTasks({
      tenant: "",
      contextId: "",
      status: 0,
      pageToken: "",
      historyLength: undefined,
      statusTimestampAfter: undefined,
      includeArtifacts: false,
      pageSize: 10,
    });
    expect(listed.tasks.length).toBe(2);
    const theirs = await factoryFor(other).createFromUrl(base);
    await expect(
      theirs.getTask({ tenant: "", id: listed.tasks[0]?.id ?? "", historyLength: undefined }),
    ).rejects.toThrow();
  });
});
