"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label, Select, Textarea } from "@/components/field";
import { useRunning } from "@/components/running";
import { api } from "@/lib/api";
import type { AgentSummary, CrewSummary, ProjectSummary, TemplateSummary } from "@/lib/types";

const PRIORITIES = [
  ["balanced", "Balanced"],
  ["quality", "Best quality"],
  ["cheap", "Lowest cost"],
  ["fast", "Fastest"],
] as const;
const MAX_FILES = 10;
const MAX_BYTES = 2 * 1024 * 1024;

interface Picked {
  name: string;
  size: number;
  content: string;
  encoding: "utf8" | "base64";
  contentType: string;
}

/** Text files go as text; anything else as base64. */
async function readFile(f: File): Promise<Picked> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const text =
    !bytes.includes(0) &&
    (f.type.startsWith("text/") || /\.(md|txt|json|csv|ya?ml|ts|js|py|html|css)$/i.test(f.name));
  if (text)
    return {
      name: f.name,
      size: f.size,
      content: new TextDecoder().decode(bytes),
      encoding: "utf8",
      contentType: f.type || "text/plain",
    };
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return {
    name: f.name,
    size: f.size,
    content: btoa(bin),
    encoding: "base64",
    contentType: f.type || "application/octet-stream",
  };
}

/** The mission composer (PRD F1): a goal, and what to start from, where the work goes, how it is staffed and paid for. */
export function NewMission({
  projects,
  agents,
  crews,
  templates,
}: {
  projects: ProjectSummary[];
  agents: AgentSummary[];
  crews: CrewSummary[];
  templates: TemplateSummary[];
}) {
  const router = useRouter();
  const { setRunning } = useRunning();
  const [goal, setGoal] = useState("");
  const [more, setMore] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number][0]>("balanced");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [budgetMinutes, setBudgetMinutes] = useState("");
  const [routing, setRouting] = useState("learned");
  const [plannerAgentId, setPlannerAgentId] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [issueUrl, setIssueUrl] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templateMode, setTemplateMode] = useState<"adapt" | "as_is">("adapt");
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runnable = agents.filter((a) => a.runnable);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(e.target.files ?? [])];
    e.target.value = "";
    const next = [...files, ...(await Promise.all(chosen.map(readFile)))].slice(0, MAX_FILES);
    if (next.reduce((n, f) => n + f.size, 0) > MAX_BYTES) {
      setError("Attached files can come to 2 MB at most.");
      return;
    }
    setError(null);
    setFiles(next);
  }

  function routingBody() {
    if (routing === "learned" || routing === "static") return { strategy: routing };
    const [kind, id] = routing.split(":");
    return kind === "crew" ? { strategy: "crew", crewId: id } : { strategy: "single", agentId: id };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRunning("new-mission", true);
    setError(null);
    const usd = Number(budgetUsd);
    const minutes = Number(budgetMinutes);
    try {
      const { mission } = await api<{ mission: { id: string } }>("/v1/missions", {
        method: "POST",
        body: {
          goal,
          priority,
          routing: routingBody(),
          autoApprove,
          ...(projectId ? { projectId } : {}),
          ...(usd > 0 || minutes > 0
            ? { budget: { ...(usd > 0 ? { usd } : {}), ...(minutes > 0 ? { minutes } : {}) } }
            : {}),
          ...(plannerAgentId ? { plannerAgentId } : {}),
          ...(issueUrl.trim() ? { issueUrl: issueUrl.trim() } : {}),
          ...(templateId ? { template: { id: templateId, mode: templateMode } } : {}),
          ...(files.length
            ? {
                files: files.map(({ name, content, encoding, contentType }) => ({
                  name,
                  content,
                  encoding,
                  contentType,
                })),
              }
            : {}),
        },
      });
      router.push(`/missions/${mission.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setRunning("new-mission", false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      aria-label="Mission composer"
    >
      <Label htmlFor="goal">New mission</Label>
      <Textarea
        id="goal"
        required
        maxLength={10_000}
        placeholder="One goal, in plain words. e.g. Add passkey sign-in to the web app, with tests and docs."
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="m-project">Project</Label>
          <Select id="m-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No repository</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="m-priority">Priority</Label>
          <Select
            id="m-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as typeof priority)}
          >
            {PRIORITIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="m-budget">Budget (USD)</Label>
          <Input
            id="m-budget"
            type="number"
            min="0"
            step="0.5"
            placeholder="no limit"
            value={budgetUsd}
            onChange={(e) => setBudgetUsd(e.target.value)}
          />
        </div>
      </div>

      {more && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="composer-more">
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-routing">Who works on it</Label>
            <Select id="m-routing" value={routing} onChange={(e) => setRouting(e.target.value)}>
              <option value="learned">Brio picks per task (learned)</option>
              <option value="static">Brio picks per task (static rules)</option>
              {crews.map((c) => (
                <option key={c.id} value={`crew:${c.id}`}>
                  Crew: {c.name}
                </option>
              ))}
              {runnable.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  Only {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-planner">Planner</Label>
            <Select id="m-planner" value={plannerAgentId} onChange={(e) => setPlannerAgentId(e.target.value)}>
              <option value="">Brio picks</option>
              {runnable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.model}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-template">Template</Label>
            <Select id="m-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-template-mode">Use the template</Label>
            <Select
              id="m-template-mode"
              value={templateMode}
              disabled={!templateId}
              onChange={(e) => setTemplateMode(e.target.value as "adapt" | "as_is")}
            >
              <option value="adapt">Adapted to this goal</option>
              <option value="as_is">As it is</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-issue">Issue link</Label>
            <Input
              id="m-issue"
              type="url"
              placeholder="https://github.com/acme/site/issues/42"
              value={issueUrl}
              onChange={(e) => setIssueUrl(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="m-minutes">Time limit (minutes)</Label>
            <Input
              id="m-minutes"
              type="number"
              min="0"
              placeholder="no limit"
              value={budgetMinutes}
              onChange={(e) => setBudgetMinutes(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="m-files">Files</Label>
            <input id="m-files" type="file" multiple onChange={pick} className="text-xs text-fg-muted" />
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {files.map((f) => (
                  <Chip key={f.name}>
                    {f.name}
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      className="ml-1 text-fg-subtle hover:text-fg"
                      onClick={() => setFiles(files.filter((x) => x.name !== f.name))}
                    >
                      ×
                    </button>
                  </Chip>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            Quick start: begin without waiting for my approval when the plan is clean, small (≤ 10 tasks) and
            under $5
          </label>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="font-mono text-2xs text-fg-muted hover:text-fg"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? "fewer options" : "more options: routing, planner, template, issue, files"}
        </button>
        <Button type="submit" variant="primary" disabled={busy || !goal.trim()}>
          Plan mission
        </Button>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}
