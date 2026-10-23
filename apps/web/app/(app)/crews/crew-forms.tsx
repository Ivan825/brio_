"use client";

import { TASK_TYPES } from "@brio/schema";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select } from "@/components/field";
import { api } from "@/lib/api";
import type { AgentSummary, CrewSummary } from "@/lib/types";

/** Makes a crew, or edits one: its name, its agents, and an agent per task type. */
export function CrewForm({
  agents,
  crew,
  onDone,
}: {
  agents: AgentSummary[];
  crew?: CrewSummary;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(crew?.name ?? "");
  const [members, setMembers] = useState<string[]>(crew?.agentIds ?? []);
  const [pins, setPins] = useState<Record<string, string>>(crew?.pins ?? {});
  const [pinType, setPinType] = useState<string>(TASK_TYPES[0]);
  const [pinAgent, setPinAgent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  const toggle = (id: string) => {
    const next = members.includes(id) ? members.filter((m) => m !== id) : [...members, id];
    setMembers(next);
    setPins(Object.fromEntries(Object.entries(pins).filter(([, a]) => next.includes(a))));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(crew ? `/v1/crews/${crew.id}` : "/v1/crews", {
        method: crew ? "PUT" : "POST",
        body: { name, agentIds: members, pins },
      });
      if (!crew) {
        setName("");
        setMembers([]);
        setPins({});
      }
      onDone?.();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const id = crew?.id ?? "new";
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      aria-label={crew ? `Edit ${crew.name}` : "New crew"}
    >
      {!crew && <h2 className="text-sm font-semibold">New crew</h2>}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>Crew name</Label>
        <Input
          id={`${id}-name`}
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">Agents</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={members.includes(a.id)} onChange={() => toggle(a.id)} />
              {a.name}
              <span className="font-mono text-2xs text-fg-subtle">{a.model}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <span className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          Who takes which tasks
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Task type"
            value={pinType}
            onChange={(e) => setPinType(e.target.value)}
            className="w-56"
          >
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Agent for the task type"
            value={pinAgent}
            onChange={(e) => setPinAgent(e.target.value)}
            className="w-44"
          >
            <option value="">choose an agent</option>
            {members.map((m) => (
              <option key={m} value={m}>
                {nameOf(m)}
              </option>
            ))}
          </Select>
          <Button
            disabled={!pinAgent}
            onClick={() => {
              setPins({ ...pins, [pinType]: pinAgent });
              setPinAgent("");
            }}
          >
            Set
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(pins).map(([type, agent]) => (
            <Chip key={type}>
              {type} → {nameOf(agent)}
              <button
                type="button"
                aria-label={`Clear ${type}`}
                className="ml-1 text-fg-subtle hover:text-fg"
                onClick={() => setPins(Object.fromEntries(Object.entries(pins).filter(([t]) => t !== type)))}
              >
                ×
              </button>
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || !members.length}>
          {crew ? "Save crew" : "Add crew"}
        </Button>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}

export function CrewList({
  crews,
  agents,
  canEdit,
}: {
  crews: CrewSummary[];
  agents: AgentSummary[];
  canEdit: boolean;
}) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Crews">
      {crews.map((c) => (
        <CrewRow key={c.id} crew={c} agents={agents} canEdit={canEdit} />
      ))}
    </ul>
  );
}

function CrewRow({ crew, agents, canEdit }: { crew: CrewSummary; agents: AgentSummary[]; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "removed agent";
  if (editing)
    return (
      <li>
        <CrewForm agents={agents} crew={crew} onDone={() => setEditing(false)} />
      </li>
    );
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4" data-testid="crew">
      <div className="flex items-center gap-2">
        <span className="font-medium">{crew.name}</span>
        <span className="font-mono text-2xs text-fg-subtle">{crew.agentIds.length} agents</span>
        {canEdit && (
          <span className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await api(`/v1/crews/${crew.id}`, { method: "DELETE" });
                  router.refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Delete
            </Button>
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {crew.agentIds.map((a) => (
          <Chip key={a}>{nameOf(a)}</Chip>
        ))}
      </div>
      {Object.keys(crew.pins).length > 0 && (
        <p className="font-mono text-2xs text-fg-muted">
          {Object.entries(crew.pins)
            .map(([t, a]) => `${t} → ${nameOf(a)}`)
            .join(" · ")}
        </p>
      )}
      <FormError>{error}</FormError>
    </li>
  );
}
