"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError, Input, Label } from "@/components/field";
import { api } from "@/lib/api";
import type { ProjectSummary } from "@/lib/types";

export function NewProject() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    repoUrl: "",
    defaultBranch: "",
    gitToken: "",
    githubRepo: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim()));
      await api("/v1/projects", { method: "POST", body });
      setForm({ name: "", repoUrl: "", defaultBranch: "", gitToken: "", githubRepo: "" });
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
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      aria-label="New project"
    >
      <h2 className="text-sm font-semibold">New project</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" required maxLength={80} value={form.name} onChange={set("name")} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="p-branch">Default branch</Label>
          <Input
            id="p-branch"
            placeholder="main"
            value={form.defaultBranch}
            onChange={set("defaultBranch")}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="p-repo">Repository</Label>
          <Input
            id="p-repo"
            placeholder="https://github.com/acme/site.git"
            value={form.repoUrl}
            onChange={set("repoUrl")}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="p-token">Git token (optional)</Label>
          <Input
            id="p-token"
            type="password"
            autoComplete="off"
            placeholder="github_pat_…"
            value={form.gitToken}
            onChange={set("gitToken")}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="p-gh">GitHub repository for pull requests</Label>
          <Input
            id="p-gh"
            placeholder="acme/site (when not a github.com URL)"
            value={form.githubRepo}
            onChange={set("githubRepo")}
          />
        </div>
      </div>
      <p className="text-xs text-fg-muted">
        The token is sealed in the workspace vault. Brio uses it to fetch a private repository and, once you
        approve, to push the mission&apos;s branch and open its pull request. Agents never see it. A
        fine-grained token with Contents and Pull requests (read and write) on this repository is enough.
      </p>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !form.name.trim()}>
          Add project
        </Button>
      </div>
      <FormError>{error}</FormError>
    </form>
  );
}

export function ProjectList({ projects, canEdit }: { projects: ProjectSummary[]; canEdit: boolean }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Projects">
      {projects.map((p) => (
        <ProjectRow key={p.id} project={p} canEdit={canEdit} />
      ))}
    </ul>
  );
}

function ProjectRow({ project: p, canEdit }: { project: ProjectSummary; canEdit: boolean }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/projects/${p.id}`, { method: "PATCH", body });
      setToken("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4" data-testid="project">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        {p.defaultBranch && <Chip>{p.defaultBranch}</Chip>}
        <Chip tone={p.hasToken ? "success" : "muted"}>{p.hasToken ? "token set" : "no token"}</Chip>
        {p.githubRepo && <Chip>PRs → {p.githubRepo}</Chip>}
      </div>
      <p className="truncate font-mono text-xs text-fg-muted">
        {p.repoUrl ?? "no repository: missions start empty"}
      </p>
      {canEdit && p.repoUrl && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`New git token for ${p.name}`}
            type="password"
            autoComplete="off"
            placeholder={p.hasToken ? "Replace the git token" : "Add a git token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="max-w-xs"
          />
          <Button disabled={busy || token.trim().length < 8} onClick={() => patch({ gitToken: token })}>
            Save token
          </Button>
          {p.hasToken && (
            <Button variant="ghost" disabled={busy} onClick={() => patch({ gitToken: null })}>
              Remove token
            </Button>
          )}
        </div>
      )}
      <FormError>{error}</FormError>
    </li>
  );
}
