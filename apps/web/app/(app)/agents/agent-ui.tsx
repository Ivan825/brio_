"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select, Textarea } from "@/components/field";
import { api } from "@/lib/api";
import { perM, usd } from "@/lib/format";
import type { AgentSummary, ConnectorModel, InstalledConnector } from "@/lib/types";

export function AgentList({ agents }: { agents: AgentSummary[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="agents-title" className="flex flex-col gap-3">
      <h2 id="agents-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
        Your agents · {agents.length}
      </h2>
      {agents.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 font-mono text-sm text-fg-muted">
          <span className="select-none text-fg-subtle">$ </span>no agents yet. Build one below.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
              data-testid="agent"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-medium">{a.name}</span>
                  <span className="truncate font-mono text-xs text-fg-muted">
                    {a.connector?.displayName ?? "connector removed"} · {a.model}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {a.price ? (
                    <Chip title={`price from ${a.price.kind}`}>
                      {perM(a.price.inputPerM)} / {perM(a.price.outputPerM)} per M
                    </Chip>
                  ) : (
                    <Chip tone="warning">price unknown</Chip>
                  )}
                  {!a.modelListed && <Chip tone="warning">model not in live list</Chip>}
                  <Chip>max {usd(a.limits.maxCostUsd ?? 1)}</Chip>
                </div>
              </div>
              {a.rolePrompt && <p className="line-clamp-2 text-xs text-fg-muted">{a.rolePrompt}</p>}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    setError(null);
                    try {
                      await api(`/v1/agents/${a.id}`, { method: "DELETE" });
                      router.refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <FormError>{error}</FormError>
    </section>
  );
}

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

export function AgentBuilder({ connectors: all }: { connectors: InstalledConnector[] }) {
  // Search, page-fetch and cloud-browser connectors are tools agents use, never agents themselves.
  const connectors = all.filter(
    (c) =>
      c.serviceKind !== "search" &&
      c.serviceKind !== "fetch" &&
      c.serviceKind !== "cloud-browser" &&
      c.serviceKind !== "mcp",
  );
  // MCP servers attach to agents as tools.
  const mcpServers = all.filter((c) => c.serviceKind === "mcp");
  const [tools, setTools] = useState<string[]>([]);
  const router = useRouter();
  const ids = useId();
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const [models, setModels] = useState<ConnectorModel[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [rolePrompt, setRolePrompt] = useState("");
  const [maxCostUsd, setMaxCostUsd] = useState("1");
  const [maxMinutes, setMaxMinutes] = useState("10");
  const [maxTokens, setMaxTokens] = useState("8192");
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [options, setOptions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectorId) return;
    let live = true;
    setModels([]);
    setModelError(null);
    api<{ models: ConnectorModel[] }>(`/v1/connectors/${connectorId}/models`)
      .then((r) => live && setModels(r.models))
      .catch((e: Error) => live && setModelError(e.message));
    return () => {
      live = false;
    };
  }, [connectorId]);

  if (connectors.length === 0)
    return (
      <section className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
        <h2 className="font-medium">Build an agent</h2>
        <p className="text-fg-muted">
          Add a connector first:{" "}
          <Link href="/connectors" className="text-focus hover:underline">
            connectors
          </Link>
          .
        </p>
      </section>
    );

  const chosen = models.find((m) => m.id === model);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let parsed: Record<string, unknown> = {};
      if (options.trim()) {
        try {
          parsed = JSON.parse(options) as Record<string, unknown>;
        } catch {
          throw new Error('Options must be a JSON object, like {"voiceId": "…"}');
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Options must be a JSON object");
      }
      const override =
        priceIn && priceOut
          ? {
              inputPerM: Number(priceIn),
              outputPerM: Number(priceOut),
              cachedInputPerM: null,
              cacheWritePerM: null,
            }
          : null;
      await api("/v1/agents", {
        method: "POST",
        body: {
          connectorId,
          name,
          model,
          rolePrompt,
          limits: { maxCostUsd: num(maxCostUsd), maxMinutes: num(maxMinutes), maxTokens: num(maxTokens) },
          priceOverride: override,
          options: parsed,
          tools: tools.map((connectorId) => ({ connectorId })),
        },
      });
      setName("");
      setRolePrompt("");
      setOptions("");
      setTools([]);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="builder-title"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2 id="builder-title" className="font-medium">
        Build an agent
      </h2>
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input
            id={`${ids}-name`}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="reviewer"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-connector`}>Connector</Label>
          <Select
            id={`${ids}-connector`}
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} · {c.presetName ?? c.preset ?? c.service}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1 md:col-span-2">
          <Label htmlFor={`${ids}-model`}>Model (live list{models.length ? `, ${models.length}` : ""})</Label>
          <Input
            id={`${ids}-model`}
            required
            list={`${ids}-models`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="font-mono"
            placeholder="pick from the vendor's list"
          />
          <datalist id={`${ids}-models`}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName ?? m.id}
              </option>
            ))}
          </datalist>
          {modelError && (
            <p className="font-mono text-xs text-warning">model list unavailable: {modelError}</p>
          )}
          {chosen && (
            <p className="font-mono text-2xs text-fg-subtle">
              {chosen.price
                ? `${perM(chosen.price.inputPerM)} in · ${perM(chosen.price.outputPerM)} out per M tokens (${chosen.price.kind})`
                : "no known price: set one below to run this agent"}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 md:col-span-2">
          <Label htmlFor={`${ids}-role`}>Role prompt</Label>
          <Textarea
            id={`${ids}-role`}
            value={rolePrompt}
            onChange={(e) => setRolePrompt(e.target.value)}
            placeholder="You review code for correctness and security. Be specific and brief."
          />
        </div>
        <div className="grid grid-cols-3 gap-2 md:col-span-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-cost`}>Max $ per attempt</Label>
            <Input
              id={`${ids}-cost`}
              type="number"
              min="0"
              step="0.01"
              value={maxCostUsd}
              onChange={(e) => setMaxCostUsd(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-min`}>Max minutes</Label>
            <Input
              id={`${ids}-min`}
              type="number"
              min="1"
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-tok`}>Max output tokens</Label>
            <Input
              id={`${ids}-tok`}
              type="number"
              min="1"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              className="font-mono"
            />
          </div>
        </div>
        <fieldset className="grid grid-cols-2 gap-2 md:col-span-2">
          <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
            Your price per M tokens (optional: overrides the table)
          </legend>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-pin`}>Input $</Label>
            <Input
              id={`${ids}-pin`}
              type="number"
              min="0"
              step="any"
              value={priceIn}
              onChange={(e) => setPriceIn(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-pout`}>Output $</Label>
            <Input
              id={`${ids}-pout`}
              type="number"
              min="0"
              step="any"
              value={priceOut}
              onChange={(e) => setPriceOut(e.target.value)}
              className="font-mono"
            />
          </div>
        </fieldset>
        {mcpServers.length > 0 && (
          <fieldset className="flex flex-col gap-1 md:col-span-2">
            <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
              MCP tools it may use
            </legend>
            {mcpServers.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={tools.includes(m.id)}
                  onChange={(e) =>
                    setTools((v) => (e.target.checked ? [...v, m.id] : v.filter((x) => x !== m.id)))
                  }
                />
                {m.displayName}
                <span className="font-mono text-2xs text-fg-subtle">{m.health.detail ?? ""}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex flex-col gap-1 md:col-span-2">
          <Label htmlFor={`${ids}-options`}>Options (optional JSON)</Label>
          <Textarea
            id={`${ids}-options`}
            rows={2}
            spellCheck={false}
            placeholder='{"usdPerUnit": 0.01} · {"voiceId": "…"} · {"browser": "cloud"}'
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            className="font-mono"
          />
          <p className="text-2xs text-fg-subtle">
            Service agents read their settings here: a price per credit, image or second (usdPerUnit), a voice
            (voice, voiceId), a cloud browser for computer use (browser: cloud).
          </p>
        </div>
        <div className="flex flex-col gap-2 md:col-span-2">
          <FormError>{error}</FormError>
          <div>
            <Button type="submit" variant="primary" disabled={busy || !name.trim() || !model.trim()}>
              {busy ? "Saving…" : "Save agent"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
