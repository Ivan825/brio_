// What every hosted agent is told and given: the task, the agent's role, and — when the project lives on GitHub where
// the vendor's sandbox can reach it — the repository, with the rule that its changes come back as one patch. Brio
// applies that patch to the task's own worktree, so checks, merges and integration work as for any other agent.
import type { AdapterCapabilities, ProducedFile, RunInput } from "../../types";

/** The file a hosted agent writes its changes to (a `git diff` against the starting branch). */
export const PATCH_FILE = "changes.patch";

/** owner/repo when the project is an https GitHub repository a hosted agent can clone. */
export function githubRepo(input: RunInput): { url: string; slug: string; branch: string } | null {
  const url = input.repo?.url ?? "";
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return null;
  return {
    url: `https://github.com/${m[1]}/${m[2]}`,
    slug: `${m[1]}/${m[2]}`,
    branch: input.repo?.branch ?? "main",
  };
}

/** The prompt for a hosted agent: role, task, and how to hand back changes and files. */
export function hostedPrompt(input: RunInput, outputsDir: string, rolePrompt = ""): string {
  const repo = githubRepo(input);
  return [
    rolePrompt,
    input.instructions,
    repo
      ? [
          "## Repository",
          `Work on ${repo.url} starting from the ${repo.branch} branch.`,
          `When you change files, do not push or open a pull request. Instead write the full \`git diff ${repo.branch}\` of your changes (new files included) to ${outputsDir}/${PATCH_FILE}.`,
        ].join("\n")
      : "",
    `Put any other files you produce (images, documents, data) in ${outputsDir}/. End with a short summary of what you did.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const hostedCapabilities =
  (o: Partial<AdapterCapabilities> = {}) =>
  (): AdapterCapabilities => ({
    taskTypes: [],
    editsFiles: true,
    runsCode: true,
    browses: false,
    producesMedia: [],
    streaming: false,
    supportsMcpTools: false,
    supportsResume: false,
    runnerModes: ["cloud"],
    ...o,
  });

const MIME: Record<string, ProducedFile["kind"]> = { image: "image", video: "video", audio: "audio" };

/** A file a hosted agent produced, as a produced file (or the patch, which is applied instead). */
export function producedFile(name: string, contentType: string, bytes: Uint8Array): ProducedFile {
  const top = contentType.split("/")[0] ?? "";
  return { kind: MIME[top] ?? "file", name: name.split("/").pop() ?? name, contentType, bytes };
}

export const isPatch = (name: string) => name.split("/").pop() === PATCH_FILE;
export const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** Pulls the text out of the vendors' content-block lists ([{type:"text", text}…]). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}
