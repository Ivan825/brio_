import type { TaskType } from "@brio/schema";
import { TASK_TYPES } from "@brio/schema";
import data from "../../../registry/connectors.json" with { type: "json" };
import {
  AdapterFamily,
  type Category,
  type ConnectorEntry,
  type Preset,
  RegistryFile,
  type RegistryFile as RegistryFileType,
  type Tier,
} from "./schema";

export class RegistryError extends Error {
  override name = "RegistryError";
}

const milestoneNumber = (m: string) => Number.parseInt(m.slice(1), 10);

/** The model-API families, whose vendors are registry presets (D-27). */
export const isApiFamily = (family: string) => AdapterFamily.safeParse(family).success;

/** "openai-compatible:xai" → { family: "openai-compatible", preset: "xai" }; "anthropic" → preset "anthropic". */
export function parsePlannedAdapter(planned: string): { family: string; preset: string } {
  const [family = "", preset] = planned.split(":");
  return { family, preset: preset ?? family };
}

function matches(pattern: string, type: string): boolean {
  return pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

export interface CoverageGap {
  connector: string;
  plannedAdapter: string;
  reason: "no adapter" | "no preset";
}

/** The validated connector registry with lookups. Construct with `loadRegistry()`. */
export class Registry {
  readonly categories: readonly Category[];
  readonly connectors: readonly ConnectorEntry[];
  readonly presets: Readonly<Record<string, Preset>>;
  readonly generatedOn: string;
  private readonly byId: Map<string, ConnectorEntry>;
  private readonly categoryById: Map<string, Category>;

  constructor(file: RegistryFileType) {
    this.categories = file.categories;
    this.connectors = file.connectors;
    this.presets = file.presets;
    this.generatedOn = file.generatedOn;
    this.byId = new Map(file.connectors.map((c) => [c.id, c]));
    this.categoryById = new Map(file.categories.map((c) => [c.id, c]));
    this.checkIntegrity();
  }

  connector(id: string): ConnectorEntry | undefined {
    return this.byId.get(id);
  }

  category(id: string): Category | undefined {
    return this.categoryById.get(id);
  }

  preset(key: string): Preset | undefined {
    return this.presets[key];
  }

  /** The presets that reach a connector (e.g. "together-fireworks-deepinfra" → together, fireworks). */
  presetsFor(connectorId: string): Array<{ key: string; preset: Preset }> {
    return Object.entries(this.presets)
      .filter(([, p]) => p.connector === connectorId)
      .map(([key, preset]) => ({ key, preset }));
  }

  /** Task types a connector can be asked to do: its own list, else its category's. Unsupported connectors do nothing. */
  taskTypesOf(connectorId: string): TaskType[] {
    const c = this.byId.get(connectorId);
    if (!c?.supported) return [];
    const patterns = c.taskTypes ?? this.categoryById.get(c.category)?.taskTypes ?? [];
    return TASK_TYPES.filter((t) => patterns.some((p) => matches(p, t)));
  }

  /** Capability lookup: supported connectors that can take a task type, best tier first. */
  connectorsFor(type: TaskType, opts: { implementedFamilies?: ReadonlySet<string> } = {}): ConnectorEntry[] {
    const tierRank = (t: Tier) => Number.parseInt(t.slice(1), 10);
    return this.connectors
      .filter((c) => this.taskTypesOf(c.id).includes(type))
      .filter((c) => !opts.implementedFamilies || this.isImplemented(c.id, opts.implementedFamilies))
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name));
  }

  /**
   * True when the connector's planned adapter exists, and, for the model-API families (whose vendors are data), its
   * preset is in the registry. Other adapters (coding CLIs) carry their vendor specifics in code.
   */
  isImplemented(connectorId: string, implementedFamilies: ReadonlySet<string>): boolean {
    const c = this.byId.get(connectorId);
    if (!c?.supported || !c.plannedAdapter) return false;
    const { family } = parsePlannedAdapter(c.plannedAdapter);
    if (!implementedFamilies.has(family)) return false;
    return !isApiFamily(family) || this.presetsFor(c.id).length > 0;
  }

  /**
   * The CI check (ADAPTER_SPEC §1): every supported P0/P1 connector with a planned adapter, scheduled for a milestone
   * up to `through`, must have its adapter family implemented and its preset defined.
   */
  coverageGaps(implementedFamilies: ReadonlySet<string>, through: string): CoverageGap[] {
    const gaps: CoverageGap[] = [];
    for (const c of this.connectors) {
      if (!c.supported || !c.plannedAdapter || !c.buildMilestone) continue;
      if (c.tier !== "P0" && c.tier !== "P1") continue;
      if (milestoneNumber(c.buildMilestone) > milestoneNumber(through)) continue;
      const { family, preset } = parsePlannedAdapter(c.plannedAdapter);
      if (!implementedFamilies.has(family))
        gaps.push({ connector: c.id, plannedAdapter: c.plannedAdapter, reason: "no adapter" });
      else if (isApiFamily(family) && (!this.presets[preset] || this.presets[preset]?.connector !== c.id))
        gaps.push({ connector: c.id, plannedAdapter: c.plannedAdapter, reason: "no preset" });
    }
    return gaps;
  }

  private checkIntegrity(): void {
    const problems: string[] = [];
    const ids = new Set<string>();
    for (const c of this.connectors) {
      if (ids.has(c.id)) problems.push(`duplicate connector id ${c.id}`);
      ids.add(c.id);
      if (!this.categoryById.has(c.category)) problems.push(`${c.id}: unknown category ${c.category}`);
      const unsupportedRoute = c.routes.includes("none");
      if (unsupportedRoute && c.supported) problems.push(`${c.id}: route "none" must be unsupported`);
      if (!c.supported && c.plannedAdapter) problems.push(`${c.id}: unsupported connectors have no adapter`);
    }
    for (const [key, p] of Object.entries(this.presets)) {
      const c = this.byId.get(p.connector);
      if (!c) problems.push(`preset ${key}: unknown connector ${p.connector}`);
      else if (!c.supported) problems.push(`preset ${key}: connector ${c.id} is unsupported`);
    }
    if (problems.length) throw new RegistryError(`invalid registry:\n- ${problems.join("\n- ")}`);
  }
}

/** Parses and validates a registry file (defaults to registry/connectors.json). Throws on any problem. */
export function loadRegistry(raw: unknown = data): Registry {
  const parsed = RegistryFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n- ");
    throw new RegistryError(`invalid registry:\n- ${issues}`);
  }
  return new Registry(parsed.data);
}

let cached: Registry | undefined;

/** The repo's registry, parsed once. */
export function registry(): Registry {
  cached ??= loadRegistry();
  return cached;
}
