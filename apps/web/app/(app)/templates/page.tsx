import type { Metadata } from "next";
import { EmptyState } from "@/components/empty-state";
import { getWorkspaces, serverApi } from "@/lib/server-api";
import type { TemplateSummary } from "@/lib/types";
import { TemplateList } from "./template-list";

export const metadata: Metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const { workspaces } = await getWorkspaces();
  const active = workspaces.find((w) => w.active);
  if (!active)
    return (
      <EmptyState label="templates" command="brio workspace create acme" title="Create a workspace first">
        Templates are plans saved for reuse in a workspace.
      </EmptyState>
    );
  const { data } = await serverApi<{ templates: TemplateSummary[] }>("/v1/templates");
  const templates = data?.templates ?? [];
  if (!templates.length)
    return (
      <EmptyState label="templates" command="brio run --template research-memo" title="No templates yet">
        Save a mission&apos;s plan as a template from its board (“Save as template”), then start new missions
        from it: adapted to the new goal by the planner, or as it is.
      </EmptyState>
    );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">templates</p>
        <h1 className="text-xl font-semibold tracking-tight">Templates</h1>
        <p className="text-sm text-fg-muted">
          Plans saved as reusable pipelines. Pick one in the mission composer under “more options”.
        </p>
      </header>
      <TemplateList templates={templates} canEdit={active.role !== "viewer"} />
    </div>
  );
}
