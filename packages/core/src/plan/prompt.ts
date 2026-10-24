// The planner's instructions (ROUTING §2): decompose into typed tasks with contracts, contract-first, footprints for
// code tasks, estimates, at most 3 blocking questions. Pure: the orchestrator supplies the context.
import { TASK_TYPES } from "@brio/schema";
import { fence, untrustedBlock } from "../verify/untrusted";

export interface PlannerContext {
  goal: string;
  /** Files of the project repository (a repo map), when there is one. */
  repoFiles: string[];
  /** The repo map comes as an attachment instead (the runner reads it from its repository cache). */
  repoAttached?: boolean;
  /** What the connected agents can do: task types available right now. */
  availableTaskTypes: string[];
  budgetUsd?: number;
  /** Earlier attempts' problems, for a retry. */
  feedback?: string[];
  /** The user's answers to the planner's questions, and edits they asked for. */
  userNotes?: string[];
  /** Replanning after a task failed for good: what failed, and the finished tasks (as planned) to keep. */
  replan?: {
    failed: { key: string; title: string; reasons: string[] };
    done: unknown[];
  };
  /** A saved pipeline (PRD F5) to follow: its shape stays, its words are rewritten for this goal. */
  template?: { name: string; graph: unknown };
}

/** How the planner should use each acceptance check kind (ROUTING §4.1); the verifier runs all of them. */
export const CHECK_GUIDE = [
  "tests, typecheck, lint, build: a shell command run from the repository root",
  "diff_scope: the changed files stay inside expectedFootprint",
  'contract_conformance: {"contract":"<design task key>"} (a JSON Schema in the contract is validated; otherwise a reviewer from another vendor compares)',
  'rubric_review: {"criteria":["…"],"threshold":4} for writing, design and anything judged on quality',
  "fact_check and citation_present: for researched writing with numbered sources ([1]: https://…)",
  "link_check: every link in the result answers",
  'media_spec: {"params":{"formats":["png"],"width":1200,"maxDurationS":30}} for images, audio and video',
  'a11y and lighthouse: {"params":{"path":"web/index.html"}} for web pages',
  "human: a person approves the result",
] as const;

export function plannerInstructions(c: PlannerContext): string {
  const files = c.repoFiles.slice(0, 400);
  return [
    "# Plan this mission",
    "",
    "## Goal",
    c.goal,
    "",
    c.repoAttached
      ? "## Repository\nThe repository's file list is attached below; plan footprints against it."
      : c.repoFiles.length
        ? `## Repository (${c.repoFiles.length} files${c.repoFiles.length > files.length ? `, first ${files.length}` : ""})\n${files.join("\n")}`
        : "## Repository\nThere is no repository: the work starts from an empty one.",
    "",
    "## What the connected agents can do",
    c.availableTaskTypes.join(", ") || "nothing yet",
    c.budgetUsd !== undefined ? `\n## Budget\nAt most $${c.budgetUsd} for the whole mission.` : "",
    c.userNotes?.length ? `\n## From the user\n${c.userNotes.map((n) => `- ${n}`).join("\n")}` : "",
    c.template && !c.replan
      ? [
          `\n## Template: ${c.template.name}`,
          "The user chose this saved pipeline. Keep its shape: the same tasks with the same types, dependencies, modes and pinned agents. Rewrite titles, objectives, outputs, footprints and checks for this goal; add or drop a task only when the goal clearly needs it, and say so in assumptions.",
          fence(JSON.stringify(c.template.graph, null, 2), "json"),
        ].join("\n")
      : "",
    c.replan
      ? [
          "\n## Replanning",
          `The approved plan could not finish: task ${c.replan.failed.key} ("${c.replan.failed.title}") failed for good.`,
          untrustedBlock("Why it failed", c.replan.failed.reasons.map((r) => `- ${r}`).join("\n")),
          "Propose a complete plan for the goal that gets past this failure (another approach, a split, different checks).",
          c.replan.done.length
            ? `These tasks are done. Copy them into your plan exactly as they are (same key, type and contract) and their work is kept:\n${fence(JSON.stringify(c.replan.done, null, 2), "json")}`
            : "No task is done yet.",
        ].join("\n")
      : "",
    c.feedback?.length
      ? `\n## Your previous answer was rejected\n${c.feedback.map((f) => `- ${f}`).join("\n")}\nFix these and answer again.`
      : "",
    "",
    "## Rules",
    "- Split the goal into the smallest set of tasks that can be checked independently; at most 12.",
    `- Each task has exactly one type from: ${TASK_TYPES.join(", ")}.`,
    '- Contract first: when tasks share an interface (an API between frontend and backend, a schema, component props, a file format), add a design.api_contract or design.schema task that defines it, and list it in each consumer\'s contract.inputs as {"kind":"contract","ref":"<that task\'s key>"}.',
    "- Code tasks give contract.expectedFootprint.paths: the files and globs they will change. Tasks that may touch the same files cannot run at the same time.",
    `- Acceptance checks (every task needs at least one hard check):\n${CHECK_GUIDE.map((g) => `  - ${g}`).join("\n")}`,
    "- dependsOn lists task keys. Keys are lowercase slugs like api.auth-routes.",
    "- Give each task an estimate {usd, minutes}.",
    "- Ask at most 3 questions, and only ones that block planning; put everything you assumed in assumptions.",
    "",
    "## Answer",
    "Reply with one JSON object in a ```json fence and nothing else, shaped like:",
    "```json",
    JSON.stringify(
      {
        tasks: [
          {
            key: "contract.auth-api",
            type: "design.api_contract",
            title: "Define the auth API",
            contract: {
              objective: "Write the request/response types for sign-in and sign-out",
              inputs: [],
              outputs: [{ kind: "file", description: "TypeScript types", path: "src/contracts/auth.ts" }],
              acceptance: [{ kind: "typecheck", command: "npx tsc --noEmit", hard: true }],
              constraints: [],
              expectedFootprint: { paths: ["src/contracts/auth.ts"] },
              sensitivity: "internal",
            },
            dependsOn: [],
            suggestedMode: "single",
            estimate: { usd: 0.2, minutes: 4 },
          },
        ],
        assumptions: ["…"],
        questions: [],
      },
      null,
      2,
    ),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
