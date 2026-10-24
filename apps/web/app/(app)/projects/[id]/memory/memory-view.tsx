"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select, Textarea } from "@/components/field";
import { api } from "@/lib/api";

export interface MemoryItem {
  id: string;
  kind: "decision" | "contract" | "file" | "preference" | "fact" | "task" | "agent" | "prompt";
  title: string;
  body: string;
  updatedAt: string;
}

const KINDS: Array<[MemoryItem["kind"] | "", string]> = [
  ["", "Everything"],
  ["decision", "Decisions"],
  ["preference", "Preferences"],
  ["fact", "Facts"],
  ["contract", "Contracts"],
  ["task", "Changes"],
  ["prompt", "Prompts"],
  ["file", "Files"],
  ["agent", "Agents"],
];

export function MemoryView({ projectId, items }: { projectId: string; items: MemoryItem[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<MemoryItem["kind"] | "">("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paths, setPaths] = useState("");
  const [brief, setBrief] = useState<string | null>(null);
  const [add, setAdd] = useState({
    kind: "preference" as "preference" | "fact" | "decision",
    title: "",
    body: "",
  });

  const shown = items.filter(
    (i) =>
      (!kind || i.kind === kind) &&
      (!q.trim() || `${i.title}\n${i.body}`.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    void act(() => api(`/v1/projects/${projectId}/memory`, { method: "POST", body: add })).then(() =>
      setAdd({ ...add, title: "", body: "" }),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mem-kind">Show</Label>
          <Select
            id="mem-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="w-40"
          >
            {KINDS.map(([k, l]) => (
              <option key={l} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor="mem-q">Search</Label>
          <Input
            id="mem-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="auth, Node 22, src/app.ts…"
          />
        </div>
      </div>

      <ul className="flex flex-col gap-2" aria-label="Memory">
        {shown.length === 0 && (
          <li className="text-sm text-fg-muted">Nothing here yet. Missions on this project fill it.</li>
        )}
        {shown.map((i) => (
          <Item
            key={i.id}
            item={i}
            onSave={(body) => act(() => api(`/v1/memory/${i.id}`, { method: "PATCH", body }))}
            onForget={() => act(() => api(`/v1/memory/${i.id}`, { method: "DELETE" }))}
          />
        ))}
      </ul>

      <form
        onSubmit={submit}
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
        aria-label="Remember something"
      >
        <h2 className="text-sm font-semibold">Remember something</h2>
        <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Select
            aria-label="Kind"
            value={add.kind}
            onChange={(e) => setAdd({ ...add, kind: e.target.value as typeof add.kind })}
          >
            <option value="preference">Preference</option>
            <option value="fact">Fact</option>
            <option value="decision">Decision</option>
          </Select>
          <Input
            aria-label="What to remember"
            required
            value={add.title}
            onChange={(e) => setAdd({ ...add, title: e.target.value })}
            placeholder="Use pnpm, never npm"
          />
        </div>
        <Textarea
          aria-label="Details"
          value={add.body}
          onChange={(e) => setAdd({ ...add, body: e.target.value })}
          className="min-h-16"
          placeholder="Why, or more detail (optional)"
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!add.title.trim()}>
            Remember
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-2" aria-labelledby="brief-title">
        <h2 id="brief-title" className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">
          What an agent would be told
        </h2>
        <div className="flex gap-2">
          <Input
            aria-label="Files"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            placeholder="src/auth/**, src/app.ts"
          />
          <Button
            onClick={() =>
              void act(async () => {
                const r = await api<{ summary: string }>(
                  `/v1/projects/${projectId}/brief?paths=${encodeURIComponent(paths)}`,
                );
                setBrief(r.summary || "Nothing yet.");
              })
            }
          >
            Show the brief
          </Button>
        </div>
        {brief !== null && (
          <pre
            className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-3 text-xs"
            data-testid="brief"
          >
            {brief}
          </pre>
        )}
      </section>
      <FormError>{error}</FormError>
    </div>
  );
}

function Item({
  item,
  onSave,
  onForget,
}: {
  item: MemoryItem;
  onSave: (body: { title: string; body: string }) => Promise<void>;
  onForget: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  return (
    <li
      className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3"
      data-testid="memory-item"
      data-kind={item.kind}
    >
      {editing ? (
        <>
          <Input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea
            aria-label="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-16"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void onSave({ title, body }).then(() => setEditing(false))}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip>{item.kind}</Chip>
            <span className="font-medium">{item.title}</span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onForget()}>
                Forget
              </Button>
            </span>
          </div>
          {item.body && (
            <p className="whitespace-pre-wrap text-xs text-fg-muted">{item.body.slice(0, 600)}</p>
          )}
        </>
      )}
    </li>
  );
}
