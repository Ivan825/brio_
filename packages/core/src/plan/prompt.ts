// The planner's instructions (ROUTING §2): decompose into typed tasks with contracts, contract-first, footprints for
// code tasks, estimates, at most 3 blocking questions. Pure: the orchestrator supplies the context.
import { TASK_TYPES } from "@brio/schema";

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
}

/** Acceptance checks the M3 verifier runs; the rest wait for M5 and are treated as a human check until then. */
export const RUNNABLE_CHECKS = ["tests", "typecheck", "lint", "build", "diff_scope", "human"] as const;

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
    c.feedback?.length
      ? `\n## Your previous answer was rejected\n${c.feedback.map((f) => `- ${f}`).join("\n")}\nFix these and answer again.`
      : "",
    "",
    "## Rules",
    "- Split the goal into the smallest set of tasks that can be checked independently; at most 12.",
    `- Each task has exactly one type from: ${TASK_TYPES.join(", ")}.`,
    '- Contract first: when tasks share an interface (an API between frontend and backend, a schema, component props, a file format), add a design.api_contract or design.schema task that defines it, and list it in each consumer\'s contract.inputs as {"kind":"contract","ref":"<that task\'s key>"}.',
    "- Code tasks give contract.expectedFootprint.paths: the files and globs they will change. Tasks that may touch the same files cannot run at the same time.",
    `- Acceptance checks: use ${RUNNABLE_CHECKS.join(", ")}. tests/typecheck/lint/build need a shell command that runs from the repository root. Every task needs at least one hard check.`,
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
