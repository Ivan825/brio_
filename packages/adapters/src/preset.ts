// The model preset a connector reaches. Model-API families and CLIs need one; service connectors (hosted agents,
// media, search, browsers) have a service instead, and reaching a model family with one is a misconfiguration.
import type { Preset } from "@brio/registry";
import { AdapterError } from "./errors";
import type { ConnectorConfig } from "./types";

export function presetOf(c: Pick<ConnectorConfig, "preset" | "registryKey">): Preset {
  if (!c.preset) throw new AdapterError("misconfigured", `${c.registryKey} has no model preset`);
  return c.preset;
}
