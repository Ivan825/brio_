// What the API resolves and the runner executes for one attempt (stored on attempts.dispatch). Everything the run
// needs except the credential itself, which the runner reveals from the vault just in time.
import type { SandboxSpec } from "@brio/core";
import type { AgentConfig, Route, RunInput } from "./types";

export interface Dispatch {
  version: 1;
  /** Key in ADAPTERS: a model-API family or a CLI adapter. */
  adapterKey: string;
  route: Route;
  missionId: string;
  taskId: string;
  taskKey: string;
  connectorId: string;
  /** Vault secret id; null for keyless local connectors. */
  credentialRef: string | null;
  input: Omit<RunInput, "attemptId">;
  agent: AgentConfig;
  /** Null: the attempt needs no sandbox (API models on non-file tasks). */
  sandbox: SandboxSpec | null;
  /** Which sandbox image: the base, or the one with the coding CLIs installed. */
  image: "base" | "cli";
  /** The project repository to work on; null gives the mission an empty repository. */
  repo: { url: string; branch: string | null } | null;
}
