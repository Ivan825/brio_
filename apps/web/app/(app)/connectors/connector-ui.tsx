"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select, Textarea } from "@/components/field";
import { api } from "@/lib/api";
import { perM, tokens } from "@/lib/format";
import type {
  Catalogue,
  CatalogueConnector,
  ConnectorModel,
  InstalledConnector,
  PresetSummary,
  ServiceSummary,
} from "@/lib/types";

const STATUS_TONE = { v: "success", e: "muted", p: "warning", d: "warning", x: "danger" } as const;
const STATUS_LABEL = { v: "verified", e: "established", p: "preview", d: "changing", x: "no API" } as const;

function HealthChip({ c }: { c: InstalledConnector }) {
  if (c.status === "disabled") return <Chip>disabled</Chip>;
  if (c.health.ok === true)
    return (
      <Chip tone="success" title={c.health.detail ?? undefined}>
        healthy · {c.health.latencyMs}ms
      </Chip>
    );
  if (c.health.ok === false)
    return (
      <Chip tone="danger" title={c.health.error}>
        {c.health.code ?? "error"}
      </Chip>
    );
  return <Chip>unchecked</Chip>;
}

function ModelList({ connectorId }: { connectorId: string }) {
  const [models, setModels] = useState<ConnectorModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const filterId = useId();

  async function load(refresh: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ models: ConnectorModel[] }>(
        `/v1/connectors/${connectorId}/models${refresh ? "?refresh=true" : ""}`,
      );
      setModels(res.models);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (models === null)
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" onClick={() => load(false)} disabled={busy}>
          {busy ? "Listing models…" : "List models"}
        </Button>
        <FormError>{error}</FormError>
      </div>
    );

  const shown = models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex flex-col gap-2" data-testid="model-list">
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={filterId}>{models.length} models, live from the vendor</Label>
          <Input
            id={filterId}
            placeholder="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => load(true)} disabled={busy}>
          Refresh
        </Button>
      </div>
      <FormError>{error}</FormError>
      <div className="max-h-72 overflow-auto rounded-md border border-line">
        <table className="w-full text-left font-mono text-xs tabular-nums">
          <thead className="sticky top-0 bg-surface-2 text-fg-muted">
            <tr>
              <th className="px-2 py-1 font-normal">model</th>
              <th className="px-2 py-1 font-normal">context</th>
              <th className="px-2 py-1 font-normal">in / out per M</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} className="border-t border-line">
                <td className="max-w-64 truncate px-2 py-1" title={m.displayName ?? m.id}>
                  {m.id}
                </td>
                <td className="px-2 py-1 text-fg-muted">{tokens(m.contextTokens)}</td>
                <td className="px-2 py-1 text-fg-muted">
                  {m.price ? `${perM(m.price.inputPerM)} / ${perM(m.price.outputPerM)}` : "price unknown"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Every task type, grouped as the router knows them. */
const TASK_TYPES = [
  "code.feature",
  "code.bugfix",
  "code.refactor",
  "code.tests",
  "code.review",
  "code.frontend_ui",
  "research.web",
  "research.deep_report",
  "research.fact_check",
  "write.doc",
  "write.summary",
  "write.marketing_copy",
  "data.analysis",
  "data.extraction",
  "media.image",
  "media.video",
  "media.voice",
  "browser.task",
  "plan.decompose",
];

/** An A2A agent: what its card says, and which task types Brio routes to it (its skills' suggestion, editable). */
function A2aMapping({ c }: { c: InstalledConnector }) {
  const router = useRouter();
  const [types, setTypes] = useState<string[]>(c.taskTypes ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify([...types].sort()) !== JSON.stringify([...(c.taskTypes ?? [])].sort());
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/connectors/${c.id}`, { method: "PATCH", body: { taskTypes: types } });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="a2a-mapping">
      {c.agentCard && (
        <p className="text-xs text-fg-muted">
          {c.agentCard.description}
          {c.agentCard.skills.length > 0 && <> Skills: {c.agentCard.skills.map((k) => k.name).join(", ")}.</>}
        </p>
      )}
      <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
        <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Task types Brio sends it
        </legend>
        {TASK_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-1 font-mono text-2xs">
            <input
              type="checkbox"
              checked={types.includes(t)}
              onChange={(e) => setTypes((v) => (e.target.checked ? [...v, t] : v.filter((x) => x !== t)))}
            />
            {t}
          </label>
        ))}
      </fieldset>
      {dirty && (
        <div>
          <Button size="sm" disabled={busy || types.length === 0} onClick={() => void save()}>
            Save task types
          </Button>
        </div>
      )}
      <FormError>{error}</FormError>
    </div>
  );
}

function InstalledCard({ c }: { c: InstalledConnector }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showModels, setShowModels] = useState(false);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
      data-testid="installed-connector"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.displayName}</span>
        <HealthChip c={c} />
        {c.regionLimited && <Chip tone="warning">{c.regionLimited}</Chip>}
        {c.local && <Chip>local</Chip>}
        {!c.hasKey && <Chip>no key</Chip>}
      </div>
      <p className="truncate font-mono text-xs text-fg-muted">
        {c.presetName ?? c.preset ?? c.service} · {c.baseUrl}
        {c.apiStyle ? ` · ${c.apiStyle}` : ""}
        {Object.entries(c.settings ?? {}).map(([k, v]) => ` · ${k} ${v}`)}
      </p>
      {c.serviceKind && (c.serviceKind === "search" || c.serviceKind === "fetch") && (
        <p className="text-xs text-fg-muted">
          A tool, not an agent: every agent of this workspace gets it as{" "}
          <span className="font-mono">{c.serviceKind === "search" ? "web_search" : "fetch_url"}</span> (except
          on confidential tasks).
        </p>
      )}
      {c.serviceKind === "a2a" && <A2aMapping c={c} />}
      {c.serviceKind === "mcp" && (
        <p className="text-xs text-fg-muted">
          A tool, not an agent: attach it to agents in the agent builder, and they can call its tools.
        </p>
      )}
      {c.serviceKind === "cloud-browser" && (
        <p className="text-xs text-fg-muted">
          Infrastructure, not an agent: computer-use agents with the option{" "}
          <span className="font-mono">browser: cloud</span> run on it, held to each task&apos;s sites.
        </p>
      )}
      {c.health.ok === false && c.health.error && (
        <p className="font-mono text-xs text-danger">{c.health.error}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => act("health", () => api(`/v1/connectors/${c.id}/health`, { method: "POST" }))}
        >
          {busy === "health" ? "Checking…" : "Check health"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowModels((v) => !v)}>
          {showModels ? "Hide models" : "Models"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm(`Remove ${c.displayName}? Its key is destroyed and its agents are removed.`))
              void act("remove", () => api(`/v1/connectors/${c.id}`, { method: "DELETE" }));
          }}
        >
          Remove
        </Button>
      </div>
      <FormError>{error}</FormError>
      {showModels && <ModelList connectorId={c.id} />}
    </li>
  );
}

export function InstalledList({ connectors }: { connectors: InstalledConnector[] }) {
  return (
    <section aria-labelledby="installed-title" className="flex flex-col gap-3">
      <h2 id="installed-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
        Installed · {connectors.length}
      </h2>
      {connectors.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 font-mono text-sm text-fg-muted">
          <span className="select-none text-fg-subtle">$ </span>no connectors yet. Add one from the catalogue
          below.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {connectors.map((c) => (
            <InstalledCard key={c.id} c={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AddConnector({ connector, onDone }: { connector: CatalogueConnector; onDone: () => void }) {
  const router = useRouter();
  const ids = useId();
  const [presetKey, setPresetKey] = useState(connector.presets[0]?.key ?? "");
  const preset: PresetSummary | undefined = connector.presets.find((p) => p.key === presetKey);
  const regions = Object.keys(preset?.regions ?? {});
  const [region, setRegion] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiStyle, setApiStyle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!preset) return null;
  const needsKey = preset.auth !== "none" && preset.auth !== "optional-bearer";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/connectors", {
        method: "POST",
        body: {
          registryKey: connector.id,
          preset: presetKey,
          ...(apiKey ? { apiKey } : {}),
          ...(region ? { region } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          ...(apiStyle ? { apiStyle } : {}),
        },
      });
      setApiKey("");
      onDone();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 border-t border-line pt-3"
      aria-label={`Add ${connector.name}`}
    >
      {connector.presets.length > 1 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-preset`}>Provider</Label>
          <Select id={`${ids}-preset`} value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
            {connector.presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {preset.regionLimited && <p className="font-mono text-xs text-warning">{preset.regionLimited}</p>}
      {connector.cli && (
        <p className="text-xs text-fg-muted">
          Runs the official <span className="font-mono">{connector.cli}</span> CLI headless in a sandbox, with
          your {connector.cli === "cursor-agent" ? "Cursor" : preset.name} key.
        </p>
      )}
      {regions.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-region`}>Region</Label>
          <Select id={`${ids}-region`} value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">default · {preset.baseUrl}</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r} · {preset.regions[r]}
              </option>
            ))}
          </Select>
        </div>
      )}
      {preset.baseUrlEditable && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-url`}>Base URL{preset.baseUrl ? " (optional)" : ""}</Label>
          <Input
            id={`${ids}-url`}
            type="url"
            required={!preset.baseUrl}
            placeholder={preset.baseUrl ?? "http://localhost:11434/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="font-mono"
          />
        </div>
      )}
      {preset.apiStyles.length > 1 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-style`}>API</Label>
          <Select id={`${ids}-style`} value={apiStyle} onChange={(e) => setApiStyle(e.target.value)}>
            <option value="">{preset.apiStyles[0]} (default)</option>
            {preset.apiStyles.slice(1).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
      )}
      {preset.auth !== "none" && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-key`}>API key{needsKey ? "" : " (optional)"}</Label>
          <Input
            id={`${ids}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required={needsKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="font-mono"
          />
        </div>
      )}
      <p className="font-mono text-2xs text-fg-subtle">
        verified {preset.verifiedOn} ·{" "}
        <a className="text-focus hover:underline" href={preset.docsUrl} target="_blank" rel="noreferrer">
          vendor docs
        </a>
      </p>
      <FormError>{error}</FormError>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Adding…" : `Add ${connector.cli ? connector.name : preset.name}`}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const SERVICE_KIND: Record<ServiceSummary["kind"], string> = {
  hosted: "hosted agent",
  media: "media model",
  research: "research agent",
  search: "web search for every agent",
  fetch: "page reader for every agent",
  browser: "browser agent",
  "cloud-browser": "cloud browser for computer use",
  a2a: "any A2A agent, by its URL",
  mcp: "MCP server: tools for your agents",
};

/** What a run costs, in the service's own unit, as the install form says it. */
function pricingLine(p: ServiceSummary["pricing"]): string {
  if (p.unit === "token")
    return `tokens at the model's price${p.perCallUsd ? ` + $${p.perCallUsd} a search call` : ""}`;
  if (p.unit === "usd") return "the vendor reports each run's cost";
  if (p.unit === "unmetered") return "not metered in dollars: bounded by time";
  return p.usdPerUnit !== undefined
    ? `$${p.usdPerUnit} per ${p.unit}`
    : `set a price per ${p.unit} on the agent`;
}

/** Installing a service connector (D-62): which service, its settings, and the credential its auth scheme takes. */
function AddService({ connector, onDone }: { connector: CatalogueConnector; onDone: () => void }) {
  const router = useRouter();
  const ids = useId();
  const [serviceKey, setServiceKey] = useState(connector.services[0]?.key ?? "");
  const service = connector.services.find((x) => x.key === serviceKey);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!service) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const filled = Object.fromEntries(Object.entries(settings).filter(([, v]) => v.trim()));
      await api("/v1/connectors", {
        method: "POST",
        body: {
          registryKey: connector.id,
          service: serviceKey,
          ...(secret.trim() ? { apiKey: secret.trim() } : {}),
          ...(Object.keys(filled).length ? { settings: filled } : {}),
        },
      });
      setSecret("");
      onDone();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 border-t border-line pt-3"
      aria-label={`Add ${connector.name}`}
    >
      {connector.services.length > 1 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-service`}>Service</Label>
          <Select
            id={`${ids}-service`}
            value={serviceKey}
            onChange={(e) => {
              setServiceKey(e.target.value);
              setSettings({});
            }}
          >
            {connector.services.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <Chip tone="info">{SERVICE_KIND[service.kind]}</Chip>
        <Chip title={service.pricing.note}>{pricingLine(service.pricing)}</Chip>
      </div>
      {service.notes && <p className="text-xs text-fg-muted">{service.notes}</p>}
      {service.settings.map((st) => (
        <div key={st.key} className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-${st.key}`}>
            {st.label}
            {st.required ? "" : " (optional)"}
          </Label>
          <Input
            id={`${ids}-${st.key}`}
            required={st.required}
            pattern={st.pattern}
            placeholder={st.placeholder}
            value={settings[st.key] ?? ""}
            onChange={(e) => setSettings((v) => ({ ...v, [st.key]: e.target.value }))}
            className="font-mono"
          />
          {st.help && <p className="text-2xs text-fg-subtle">{st.help}</p>}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-secret`}>
          {service.credential.kind === "json"
            ? "Credentials (JSON)"
            : service.credential.optional
              ? "Token (optional)"
              : "API key"}
        </Label>
        {service.credential.kind === "json" ? (
          <Textarea
            id={`${ids}-secret`}
            required
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder={service.credential.hint}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="font-mono"
          />
        ) : (
          <Input
            id={`${ids}-secret`}
            type="password"
            required={!service.credential.optional}
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="font-mono"
          />
        )}
      </div>
      <p className="font-mono text-2xs text-fg-subtle">
        {service.keyCheck
          ? "the key is checked when you add it"
          : "no free key check: the first run checks the key"}{" "}
        · verified {service.verifiedOn} ·{" "}
        <a className="text-focus hover:underline" href={service.docsUrl} target="_blank" rel="noreferrer">
          vendor docs
        </a>
      </p>
      <FormError>{error}</FormError>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Adding…" : `Add ${service.name}`}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CatalogueRow({ c }: { c: CatalogueConnector }) {
  const [adding, setAdding] = useState(false);
  return (
    <li
      id={`connector-${c.id}`}
      className="flex scroll-mt-4 flex-col gap-2 rounded-md border border-line bg-surface p-3"
      data-testid={`catalogue-${c.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">{c.name}</span>
          <span className="truncate text-xs text-fg-muted">{c.maker}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Chip tone={STATUS_TONE[c.statusKey]} title={c.status}>
            {STATUS_LABEL[c.statusKey]}
          </Chip>
          <Chip title="priority tier">{c.tier}</Chip>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {c.routes.map((r) => (
          <Chip key={r} tone={r === "none" ? "danger" : "info"}>
            {r}
          </Chip>
        ))}
        {c.regionLimited && <Chip tone="warning">{c.regionLimited}</Chip>}
      </div>
      <p className="text-xs text-fg-muted">{c.notes}</p>
      {!c.supported ? (
        <div className="flex flex-col gap-1">
          <p className="font-mono text-2xs text-danger">
            not supported: no official API, and Brio never drives consumer apps or reuses their sign-ins.
          </p>
          {c.alternatives.length > 0 && (
            <p className="text-xs text-fg-muted" data-testid={`alternatives-${c.id}`}>
              Use instead:{" "}
              {c.alternatives.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ", "}
                  <a className="text-focus hover:underline" href={`#connector-${a.id}`}>
                    {a.name}
                  </a>
                </span>
              ))}
            </p>
          )}
        </div>
      ) : c.implemented ? (
        adding ? (
          c.presets.length === 0 && c.services.length > 0 ? (
            <AddService connector={c} onDone={() => setAdding(false)} />
          ) : (
            <AddConnector connector={c} onDone={() => setAdding(false)} />
          )
        ) : (
          <div>
            <Button size="sm" onClick={() => setAdding(true)}>
              Add key
            </Button>
          </div>
        )
      ) : (
        <p className="font-mono text-2xs text-fg-subtle">
          arrives in {c.buildMilestone ?? "a later milestone"}
        </p>
      )}
    </li>
  );
}

export function CatalogueView({ catalogue }: { catalogue: Catalogue }) {
  const [query, setQuery] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const ids = useId();
  const q = query.trim().toLowerCase();
  const categories = useMemo(
    () =>
      catalogue.categories
        .map((cat) => ({
          ...cat,
          connectors: cat.connectors.filter(
            (c) =>
              (!availableOnly || c.implemented) &&
              (!q || `${c.name} ${c.maker} ${c.routes.join(" ")} ${c.notes}`.toLowerCase().includes(q)),
          ),
        }))
        .filter((cat) => cat.connectors.length > 0),
    [catalogue, q, availableOnly],
  );
  const total = catalogue.categories.reduce((n, c) => n + c.connectors.length, 0);

  return (
    <section aria-labelledby="catalogue-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="catalogue-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Catalogue · {total} connectors · {catalogue.categories.length} categories
        </h2>
        <div className="flex items-center gap-3">
          <label
            htmlFor={`${ids}-avail`}
            className="flex items-center gap-1.5 font-mono text-2xs text-fg-muted"
          >
            <input
              id={`${ids}-avail`}
              type="checkbox"
              checked={availableOnly}
              onChange={(e) => setAvailableOnly(e.target.checked)}
            />
            available now
          </label>
          <Input
            aria-label="Search connectors"
            placeholder="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-48"
          />
        </div>
      </div>
      {categories.map((cat) => (
        <div key={cat.id} className="flex flex-col gap-2" data-testid={`category-${cat.id}`}>
          <div>
            <h3 className="font-medium">{cat.name}</h3>
            <p className="text-xs text-fg-muted">{cat.description}</p>
          </div>
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {cat.connectors.map((c) => (
              <CatalogueRow key={c.id} c={c} />
            ))}
          </ul>
        </div>
      ))}
      {categories.length === 0 && <p className="text-fg-muted">Nothing matches.</p>}
    </section>
  );
}
