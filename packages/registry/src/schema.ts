// The shape of registry/connectors.json. The registry is data: vendors, routes, presets and verified dates live there,
// not in code (CLAUDE.md rule 8).
import { TaskType } from "@brio/schema";
import { z } from "zod";

export const RegistryRoute = z.enum([
  "api",
  "cli",
  "sdk",
  "hosted",
  "a2a",
  "mcp",
  "browser",
  "local",
  "none",
]);
export type RegistryRoute = z.infer<typeof RegistryRoute>;

export const StatusKey = z.enum(["v", "e", "p", "d", "x"]);
export type StatusKey = z.infer<typeof StatusKey>;

export const Tier = z.enum(["P0", "P1", "P2", "P3"]);
export type Tier = z.infer<typeof Tier>;

export const Milestone = z
  .string()
  .regex(/^M(?:[0-9]|10)\+?$/, "M0–M10, optionally with + (that milestone or later)");

/** A task-type pattern: an exact type ("media.voice") or a whole group ("code.*"). */
export const TaskTypePattern = z.string().refine((p) => {
  if (p.endsWith(".*")) return TaskType.options.some((t) => t.startsWith(p.slice(0, -1)));
  return TaskType.safeParse(p).success;
}, "not a task type or group pattern from the taxonomy");

export const Category = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** What connectors in this category can be asked to do, unless a connector overrides it. */
  taskTypes: z.array(TaskTypePattern),
});
export type Category = z.infer<typeof Category>;

export const ConnectorEntry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  maker: z.string().min(1),
  category: z.string().min(1),
  routes: z.array(RegistryRoute).min(1),
  howToConnect: z.string(),
  status: z.string(),
  statusKey: StatusKey,
  tier: Tier,
  notes: z.string(),
  /** `family` or `family:preset`, e.g. "openai-compatible:xai". Null until an adapter is planned. */
  plannedAdapter: z
    .string()
    .regex(/^[a-z0-9-]+(?::[a-z0-9-]+)?$/)
    .nullable(),
  buildMilestone: Milestone.nullable(),
  subscriptionUse: z.string().nullable(),
  supported: z.boolean(),
  /** Overrides the category's task types. */
  taskTypes: z.array(TaskTypePattern).optional(),
  /** Set when access is restricted by region (e.g. a US-only preview); shown in the UI. */
  regionLimited: z.string().optional(),
  /** The day the entry's vendor facts were last checked against the vendor's docs. */
  verifiedOn: z.iso.date().optional(),
});
export type ConnectorEntry = z.infer<typeof ConnectorEntry>;

export const AdapterFamily = z.enum(["openai-compatible", "anthropic", "gemini"]);
export type AdapterFamily = z.infer<typeof AdapterFamily>;

export const ApiStyle = z.enum(["responses", "chat"]);
export type ApiStyle = z.infer<typeof ApiStyle>;

/** How the credential is sent. `none`/`optional-bearer` are for local servers and self-hosted proxies. */
export const AuthScheme = z.enum(["bearer", "x-api-key", "x-goog-api-key", "optional-bearer", "none"]);
export type AuthScheme = z.infer<typeof AuthScheme>;

export const ModelListShape = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "xai",
  "dashscope",
  "together",
  "none",
]);
export type ModelListShape = z.infer<typeof ModelListShape>;

/** A vendor endpoint an adapter family talks to. Every field was checked against the vendor's docs on `verifiedOn`. */
export const Preset = z
  .object({
    connector: z.string().min(1),
    name: z.string().min(1),
    family: AdapterFamily,
    /** Null when the user must supply it (self-hosted proxies, local servers). */
    baseUrl: z.url().nullable(),
    /** Alternative base URLs by region (e.g. mainland China vs international). */
    regions: z.record(z.string(), z.url()).default({}),
    baseUrlEditable: z.boolean(),
    auth: AuthScheme,
    extraHeaders: z.record(z.string(), z.string()).default({}),
    /** Only for the openai-compatible family; the first is the default. */
    apiStyles: z.array(ApiStyle).default([]),
    tools: z.boolean(),
    /** Chat Completions only: which parameter caps output (OpenAI's own API wants max_completion_tokens). */
    maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
    /** Extra JSON fields sent with every generation request (e.g. OpenRouter usage accounting). */
    requestExtras: z.record(z.string(), z.unknown()).default({}),
    /** Extra fields for Responses API requests only (e.g. stateless mode with encrypted reasoning). */
    responsesExtras: z.record(z.string(), z.unknown()).default({}),
    models: z.object({
      path: z.string().startsWith("/").nullable(),
      shape: ModelListShape,
      /** Resolve `path` against the base URL's origin instead of the base URL (Qwen lists models off the compat path). */
      fromOrigin: z.boolean().default(false),
      /** Documented model ids for vendors without a model-list endpoint. */
      static: z.array(z.string()).default([]),
    }),
    /**
     * How a key is checked without spending money: the model list, a key-info GET, or a probe that sends an empty
     * generation request (rejected as 401/403 for a bad key and as 400/422 for a good one).
     */
    health: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("models") }),
        z.object({ kind: z.literal("get"), path: z.string().startsWith("/") }),
        z.object({ kind: z.literal("probe"), path: z.string().startsWith("/") }),
      ])
      .default({ kind: "models" }),
    /** A response header carrying the call's USD cost (LiteLLM). */
    costHeader: z.string().optional(),
    /** Where prices come from: an OpenRouter vendor prefix (e.g. "openai"), or free for local servers. */
    pricing: z.object({ openrouterPrefix: z.string().nullable(), free: z.boolean().default(false) }),
    /** True when the vendor reports the cost of each call itself (preferred over our price table). */
    reportsCost: z.boolean().default(false),
    local: z.boolean().default(false),
    regionLimited: z.string().optional(),
    docsUrl: z.url(),
    verifiedOn: z.iso.date(),
    notes: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.family === "openai-compatible" && p.apiStyles.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "openai-compatible presets need apiStyles",
        path: ["apiStyles"],
      });
    if (p.family !== "openai-compatible" && p.apiStyles.length > 0)
      ctx.addIssue({
        code: "custom",
        message: "apiStyles only apply to openai-compatible",
        path: ["apiStyles"],
      });
    if (p.health.kind === "models" && (!p.models.path || p.models.shape === "none"))
      ctx.addIssue({
        code: "custom",
        message: "health via models needs a model-list endpoint",
        path: ["health"],
      });
    if (p.baseUrl === null && !p.baseUrlEditable)
      ctx.addIssue({ code: "custom", message: "a preset without a base URL must let the user set one" });
  });
export type Preset = z.infer<typeof Preset>;

export const RegistryFile = z.object({
  version: z.string(),
  generatedOn: z.iso.date(),
  note: z.string(),
  routes: z.record(RegistryRoute, z.string()),
  statuses: z.record(StatusKey, z.string()),
  categories: z.array(Category).min(1),
  connectors: z.array(ConnectorEntry).min(1),
  presets: z.record(z.string().regex(/^[a-z0-9-]+$/), Preset),
  sources: z.array(z.object({ title: z.string(), url: z.url() })),
});
export type RegistryFile = z.infer<typeof RegistryFile>;
