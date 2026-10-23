// Tools the internal tool loop offers to API models so pure models can act as agents. A tool is offered only when its
// backing service exists for this run; nothing is offered that would only fail.
import type { RunContext, SandboxHandle, Tool } from "./types";

const MAX_TOOL_OUTPUT = 20_000;

export const clip = (s: string, max = MAX_TOOL_OUTPUT) =>
  s.length <= max ? s : `${s.slice(0, max)}\n…[${s.length - max} more characters truncated]`;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`"${key}" must be a non-empty string`);
  return v;
}

/**
 * No sandbox: for API-model attempts that do not touch files (the runner gives code tasks a container). File and shell
 * tools are not offered; calling one anyway fails closed.
 */
export const NO_SANDBOX: SandboxHandle = {
  available: false,
  readFile: () => Promise.reject(new Error("no sandbox for this attempt")),
  writeFile: () => Promise.reject(new Error("no sandbox for this attempt")),
  listFiles: () => Promise.reject(new Error("no sandbox for this attempt")),
  exec: () => Promise.reject(new Error("no sandbox for this attempt")),
  spawn: () => {
    throw new Error("no sandbox: CLI agents need the runner");
  },
};

export function fileTools(
  sandbox: SandboxHandle,
  onEdit: (path: string, op: "create" | "modify") => void,
): Tool[] {
  if (!sandbox.available) return [];
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the task's working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the working directory" } },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (args) => clip(await sandbox.readFile(str(args, "path"))),
    },
    {
      name: "write_file",
      description: "Create or replace a UTF-8 text file in the task's working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      run: async (args) => {
        const path = str(args, "path");
        const existed = await sandbox.readFile(path).then(
          () => true,
          () => false,
        );
        await sandbox.writeFile(path, typeof args.content === "string" ? args.content : "");
        onEdit(path, existed ? "modify" : "create");
        return `wrote ${path}`;
      },
    },
    {
      name: "list_files",
      description: "List files under a directory of the working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory; '.' for the root" } },
        required: ["path"],
        additionalProperties: false,
      },
      run: async (args) => clip((await sandbox.listFiles(str(args, "path"))).join("\n")),
    },
    {
      name: "run_command",
      description:
        "Run a shell command in the working directory (sandboxed, time-limited). Returns exit code and output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      run: async (args) => {
        const r = await sandbox.exec(str(args, "command"), { timeoutMs: 120_000 });
        return clip(`exit ${r.exitCode}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
      },
    },
  ];
}

export function searchTools(ctx: Pick<RunContext, "tools">): Tool[] {
  const provider = ctx.tools?.search;
  if (!provider) return [];
  return [
    {
      name: "web_search",
      description: "Search the web. Returns titles, URLs and snippets; cite URLs you rely on.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: async (args, { signal }) => {
        const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, Math.floor(args.limit))) : 5;
        const results = await provider.search(str(args, "query"), { limit, signal });
        if (results.length === 0) return "no results";
        return clip(results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n"));
      },
    },
  ];
}

export function mailboxTools(ctx: Pick<RunContext, "tools">): Tool[] {
  const mailbox = ctx.tools?.mailbox;
  if (!mailbox) return [];
  return [
    {
      name: "ask_agent",
      description:
        "Ask the agent working on another task of this mission a question and wait for the answer.",
      parameters: {
        type: "object",
        properties: { task_key: { type: "string" }, question: { type: "string" } },
        required: ["task_key", "question"],
        additionalProperties: false,
      },
      run: (args) => mailbox.askAgent(str(args, "task_key"), str(args, "question")),
    },
    {
      name: "report_blocker",
      description: "Report something that stops you from finishing this task.",
      parameters: {
        type: "object",
        properties: { description: { type: "string" } },
        required: ["description"],
        additionalProperties: false,
      },
      run: async (args) => {
        await mailbox.reportBlocker(str(args, "description"));
        return "reported";
      },
    },
    {
      name: "report_progress",
      description: "Post a short progress note to the mission board.",
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
      run: async (args) => {
        await mailbox.reportProgress(str(args, "note"));
        return "posted";
      },
    },
    {
      name: "get_contract",
      description: "Read a named interface contract of this mission.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      run: (args) => mailbox.getContract(str(args, "name")),
    },
  ];
}

/** Every tool available to this run. */
export function toolsFor(
  ctx: Pick<RunContext, "tools" | "sandbox">,
  onEdit: (path: string, op: "create" | "modify") => void,
) {
  return [...fileTools(ctx.sandbox, onEdit), ...searchTools(ctx), ...mailboxTools(ctx)];
}
