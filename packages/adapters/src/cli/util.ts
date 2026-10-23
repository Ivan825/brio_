// Small readers for untrusted CLI JSON.
import type { TokenUsage } from "@brio/core";

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const obj = (v: unknown): Obj => (isObj(v) ? v : {});
export const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export const usage = (u: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: u.inputTokens ?? 0,
  cachedInputTokens: u.cachedInputTokens ?? 0,
  cacheWriteTokens: u.cacheWriteTokens ?? 0,
  outputTokens: u.outputTokens ?? 0,
  reasoningTokens: u.reasoningTokens ?? 0,
});

/** File-editing tool names across CLIs → the edited path, if the arguments carry one. */
export function editedPath(args: Obj): string | null {
  const p = args.file_path ?? args.filePath ?? args.path ?? args.TargetFile ?? args.target_file;
  return typeof p === "string" && p ? p : null;
}

/** Paths reported relative to the sandbox root become worktree-relative. */
export const relative = (p: string) => p.replace(/^\/work\/?/, "");
