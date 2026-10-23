// A sample A2A v1.0 agent for tests, built on the official SDK's server (as the SDK's own sample agent is): it researches
// a topic (a cited answer as an artifact), and when the request says "ASK" it first asks which region (input-required),
// then answers. Served over plain node:http with the SDK's JSON-RPC handler, on an ephemeral port.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentCard, Role, TaskState } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type RequestContext,
  ServerCallContext,
} from "@a2a-js/sdk/server";

const part = (text: string) => ({
  content: { $case: "text" as const, value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

const textOf = (rc: RequestContext) =>
  rc.userMessage.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join(" ");

class SampleExecutor implements AgentExecutor {
  readonly seen: string[] = [];
  execute = async (rc: RequestContext, bus: ExecutionEventBus) => {
    const said = textOf(rc);
    this.seen.push(said);
    const now = () => new Date().toISOString();
    const status = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: rc.taskId,
          contextId: rc.contextId,
          status: {
            state,
            message: text
              ? {
                  messageId: crypto.randomUUID(),
                  contextId: rc.contextId,
                  taskId: rc.taskId,
                  role: Role.ROLE_AGENT,
                  parts: [part(text)],
                  metadata: undefined,
                  extensions: [],
                  referenceTaskIds: [],
                }
              : undefined,
            timestamp: now(),
          },
          metadata: undefined,
        }),
      );
    bus.publish(
      AgentEvent.task(
        rc.task
          ? { ...rc.task, history: [...rc.task.history, rc.userMessage] }
          : {
              id: rc.taskId,
              contextId: rc.contextId,
              status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now() },
              artifacts: [],
              history: [rc.userMessage],
              metadata: undefined,
            },
      ),
    );
    status(TaskState.TASK_STATE_WORKING, "Researching");
    if (said.includes("ASK") && !rc.task) {
      status(TaskState.TASK_STATE_INPUT_REQUIRED, "Which region should I cover?");
      bus.finished();
      return;
    }
    const region = rc.task ? ` for ${said.trim()}` : "";
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId: rc.taskId,
        contextId: rc.contextId,
        artifact: {
          artifactId: crypto.randomUUID(),
          name: "answer",
          description: "the research answer",
          parts: [
            part(
              `Agent orchestrators route each task to the best agent${region} [1].\n\n[1] https://example.com/orchestration`,
            ),
          ],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    );
    status(TaskState.TASK_STATE_COMPLETED, "Done");
    bus.finished();
  };
  cancelTask = async (taskId: string, bus: ExecutionEventBus) => {
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    bus.finished();
  };
}

export async function startSampleAgent(): Promise<{
  url: string;
  executor: SampleExecutor;
  close: () => Promise<void>;
}> {
  const executor = new SampleExecutor();
  let server: Server | null = null;
  let url = "";
  const card = () =>
    AgentCard.fromJSON({
      name: "Sample research agent",
      description: "Answers research questions with a cited source.",
      version: "1.0.0",
      supportedInterfaces: [{ url: `${url}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [
        {
          id: "research",
          name: "Research",
          description: "Find and cite sources on a topic",
          tags: ["research", "citations"],
        },
      ],
    });
  const handler = new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor);
  const transport = new JsonRpcTransportHandler(handler);
  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(AgentCard.toJSON(card())));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const out = await transport.handle(body, new ServerCallContext({ requestedVersion: "1.0" }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, executor, close: () => new Promise((r) => server?.close(() => r())) };
}
