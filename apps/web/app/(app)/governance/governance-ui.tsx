"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select } from "@/components/field";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";

const heading = "font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted";

export interface BudgetView {
  month: string;
  workspace: { limitUsd: number | null; softPct: number; spentUsd: number };
  agents: Array<{
    agentId: string;
    name: string;
    limitUsd: number | null;
    softPct: number;
    spentUsd: number;
  }>;
}

function Meter({ spent, limit }: { spent: number; limit: number | null }) {
  if (!limit) return <span className="font-mono text-xs text-fg-subtle">{usd(spent)} · no limit</span>;
  const share = Math.min(1, spent / limit);
  return (
    <span className="flex min-w-40 items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <span
          className={`block h-full ${share >= 1 ? "bg-danger" : share > 0.8 ? "bg-warning" : "bg-success"}`}
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="font-mono text-xs tabular-nums">
        {usd(spent)} of {usd(limit)}
      </span>
    </span>
  );
}

/** The workspace's and each agent's monthly budgets, and this month's spend against them. */
export function Budgets({ view, canEdit }: { view: BudgetView; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const set = async (scopeKind: "workspace" | "agent", limit: string, scopeId?: string) => {
    setError(null);
    try {
      await api("/v1/budgets", {
        method: "PUT",
        body: { scopeKind, ...(scopeId ? { scopeId } : {}), limitUsd: limit.trim() ? Number(limit) : null },
      });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section aria-labelledby="budgets-title" className="flex flex-col gap-3" data-testid="budgets">
      <h2 id="budgets-title" className={heading}>
        Budgets · {view.month}
      </h2>
      <p className="text-xs text-fg-muted">
        Monthly limits. Work whose estimate does not fit what is left does not start; past 80% everyone
        concerned is told; at the limit every running attempt stops within seconds. A mission&apos;s own
        budget is set when it is created, and raised on its board.
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        <BudgetRow
          label="Workspace"
          limit={view.workspace.limitUsd}
          spent={view.workspace.spentUsd}
          canEdit={canEdit}
          onSave={(v) => set("workspace", v)}
        />
        {view.agents.map((a) => (
          <BudgetRow
            key={a.agentId}
            label={a.name}
            limit={a.limitUsd}
            spent={a.spentUsd}
            canEdit={canEdit}
            onSave={(v) => set("agent", v, a.agentId)}
          />
        ))}
      </ul>
      <FormError>{error}</FormError>
    </section>
  );
}

function BudgetRow({
  label,
  limit,
  spent,
  canEdit,
  onSave,
}: {
  label: string;
  limit: number | null;
  spent: number;
  canEdit: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [value, setValue] = useState(limit?.toString() ?? "");
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="budget-row">
      <span className="min-w-32 font-medium">{label}</span>
      <Meter spent={spent} limit={limit} />
      {canEdit && (
        <span className="ml-auto flex items-center gap-2">
          <Input
            aria-label={`${label} monthly limit (USD)`}
            type="number"
            min="0"
            step="1"
            placeholder="no limit"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-28"
          />
          <Button size="sm" onClick={() => void onSave(value)}>
            Save
          </Button>
        </span>
      )}
    </li>
  );
}

export interface PolicyView {
  id: string;
  kind: "data_routing" | "connector_allow" | "network" | "approval";
  name: string;
  rule: Record<string, unknown>;
  enabled: boolean;
}

const KIND_LABEL: Record<PolicyView["kind"], string> = {
  data_routing: "Data routing",
  connector_allow: "Connector allow-list",
  network: "Network",
  approval: "Quick-start limits",
};

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function describeRule(p: PolicyView): string {
  const r = p.rule as Record<string, unknown>;
  switch (p.kind) {
    case "data_routing": {
      const allow = r.allow as { local?: boolean; connectors?: string[] };
      return `${r.sensitivity} work → ${[allow.local ? "local models" : "", ...(allow.connectors ?? [])].filter(Boolean).join(", ")}`;
    }
    case "connector_allow":
      return [
        r.allow ? `allow ${(r.allow as string[]).join(", ")}` : "",
        r.deny ? `deny ${(r.deny as string[]).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "network":
      return [
        r.allowHosts ? `code may also reach ${(r.allowHosts as string[]).join(", ")}` : "",
        r.denyHosts ? `never ${(r.denyHosts as string[]).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "approval":
      return `plans start on their own under $${r.autoUnderUsd} and ${r.autoUnderTasks} tasks`;
  }
}

/** The workspace's policies: what each says, on or off; owners and admins add and remove them. */
export function Policies({ policies, canEdit }: { policies: PolicyView[]; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section aria-labelledby="policies-title" className="flex flex-col gap-3" data-testid="policies">
      <h2 id="policies-title" className={heading}>
        Policies
      </h2>
      <p className="text-xs text-fg-muted">
        Enforced before any agent is chosen and again at every dispatch. Without a data-routing policy,
        confidential work goes only to local models.
      </p>
      {policies.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {policies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" data-testid="policy">
              <Chip tone={p.enabled ? "info" : "muted"}>{KIND_LABEL[p.kind]}</Chip>
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-fg-muted">{describeRule(p)}</span>
              {canEdit && (
                <span className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(() =>
                        api(`/v1/policies/${p.id}`, { method: "PATCH", body: { enabled: !p.enabled } }),
                      )
                    }
                  >
                    {p.enabled ? "Turn off" : "Turn on"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => api(`/v1/policies/${p.id}`, { method: "DELETE" }))}
                  >
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && <NewPolicy onAdd={(body) => act(() => api("/v1/policies", { method: "POST", body }))} />}
      <FormError>{error}</FormError>
    </section>
  );
}

function NewPolicy({ onAdd }: { onAdd: (body: Record<string, unknown>) => Promise<void> }) {
  const [kind, setKind] = useState<PolicyView["kind"]>("data_routing");
  const [name, setName] = useState("");
  const [sensitivity, setSensitivity] = useState("confidential");
  const [local, setLocal] = useState(true);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [usdLimit, setUsdLimit] = useState("5");
  const [tasks, setTasks] = useState("10");

  function submit(e: FormEvent) {
    e.preventDefault();
    const rule =
      kind === "data_routing"
        ? { sensitivity, allow: { local, ...(list(a).length ? { connectors: list(a) } : {}) } }
        : kind === "connector_allow"
          ? { ...(list(a).length ? { allow: list(a) } : {}), ...(list(b).length ? { deny: list(b) } : {}) }
          : kind === "network"
            ? {
                ...(list(a).length ? { allowHosts: list(a) } : {}),
                ...(list(b).length ? { denyHosts: list(b) } : {}),
              }
            : { action: "approve_plan", autoUnderUsd: Number(usdLimit), autoUnderTasks: Number(tasks) };
    void onAdd({ kind, name, rule }).then(() => {
      setName("");
      setA("");
      setB("");
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      aria-label="New policy"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pol-kind">Kind</Label>
          <Select id="pol-kind" value={kind} onChange={(e) => setKind(e.target.value as PolicyView["kind"])}>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pol-name">Policy name</Label>
          <Input id="pol-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {kind === "data_routing" && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pol-sens">Work that is</Label>
              <Select id="pol-sens" value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
                <option value="confidential">confidential</option>
                <option value="internal">internal</option>
                <option value="public">public</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pol-a">may go to connectors (registry ids, comma-separated)</Label>
              <Input
                id="pol-a"
                placeholder="azure-openai, claude-api"
                value={a}
                onChange={(e) => setA(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /> and to
              local models
            </label>
          </>
        )}
        {(kind === "connector_allow" || kind === "network") && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pol-a">
                {kind === "network" ? "Code sandboxes may also reach" : "Allow only"}
              </Label>
              <Input
                id="pol-a"
                placeholder={kind === "network" ? "npm.acme.internal" : "claude-api, ollama"}
                value={a}
                onChange={(e) => setA(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pol-b">{kind === "network" ? "Never reach" : "Deny"}</Label>
              <Input
                id="pol-b"
                placeholder={kind === "network" ? "registry.npmjs.org" : "groq-api"}
                value={b}
                onChange={(e) => setB(e.target.value)}
              />
            </div>
          </>
        )}
        {kind === "approval" && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pol-usd">Plans start on their own under (USD)</Label>
              <Input
                id="pol-usd"
                type="number"
                min="0"
                value={usdLimit}
                onChange={(e) => setUsdLimit(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pol-tasks">and at most (tasks)</Label>
              <Input
                id="pol-tasks"
                type="number"
                min="0"
                value={tasks}
                onChange={(e) => setTasks(e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Add policy
        </Button>
      </div>
    </form>
  );
}

interface LedgerEntry {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  hash: string;
  createdAt: string;
}

/** The audit ledger: recent entries, the chain verified end to end, and exports for auditors. */
export function Ledger() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<{
    ok: boolean;
    length?: number;
    brokenAt?: number;
    reason?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (before?: number) => {
    try {
      const page = await api<{ entries: LedgerEntry[]; next: number | null }>(
        `/v1/ledger?limit=50${before ? `&before=${before}` : ""}`,
      );
      setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
      setNext(page.next);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    void load();
  }, []);
  return (
    <section aria-labelledby="ledger-title" className="flex flex-col gap-3" data-testid="ledger">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="ledger-title" className={heading}>
          Audit ledger
        </h2>
        <span className="ml-auto flex items-center gap-2">
          {verdict && (
            <Chip tone={verdict.ok ? "success" : "danger"}>
              {verdict.ok
                ? `chain intact · ${verdict.length} entries`
                : `broken at #${verdict.brokenAt}: ${verdict.reason}`}
            </Chip>
          )}
          <Button
            size="sm"
            onClick={async () => {
              try {
                setVerdict(await api("/v1/ledger/verify"));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Verify the chain
          </Button>
          <a className="font-mono text-2xs text-focus hover:underline" href="/v1/ledger/export?format=jsonl">
            JSONL
          </a>
          <a className="font-mono text-2xs text-focus hover:underline" href="/v1/ledger/export?format=csv">
            CSV
          </a>
        </span>
      </div>
      <ol className="divide-y divide-line rounded-lg border border-line font-mono text-xs">
        {entries.map((e) => (
          <li key={e.seq} className="flex flex-wrap gap-3 px-3 py-1.5" data-testid="ledger-entry">
            <span className="w-8 text-right text-fg-subtle">{e.seq}</span>
            <span className="text-fg-subtle">{new Date(e.createdAt).toLocaleString()}</span>
            <span>{e.kind}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted" title={JSON.stringify(e.payload)}>
              {JSON.stringify(e.payload)}
            </span>
            <span className="text-fg-subtle" title={e.hash}>
              {e.hash.slice(0, 10)}
            </span>
          </li>
        ))}
      </ol>
      {next && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => void load(next)}>
            Older entries
          </Button>
        </div>
      )}
      <FormError>{error}</FormError>
    </section>
  );
}
