"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/button";
import { Chip } from "@/components/chip";
import { FormError } from "@/components/field";
import { api } from "@/lib/api";
import type { TemplateSummary } from "@/lib/types";

export function TemplateList({ templates, canEdit }: { templates: TemplateSummary[]; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ul className="flex flex-col gap-3" aria-label="Templates">
        {templates.map((t) => (
          <li
            key={t.id}
            className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
            data-testid="template"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{t.name}</span>
              <span className="font-mono text-2xs text-fg-subtle">{t.tasks.length} tasks</span>
              {t.source && (
                <Link
                  href={`/missions/${t.source.missionId}`}
                  className="font-mono text-2xs text-focus hover:underline"
                >
                  from a mission · v{t.source.version}
                </Link>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={async () => {
                    try {
                      await api(`/v1/templates/${t.id}`, { method: "DELETE" });
                      router.refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
            {t.description && <p className="text-sm text-fg-muted">{t.description}</p>}
            <ol className="flex flex-wrap items-center gap-1 text-xs">
              {t.tasks.map((x, i) => (
                <li key={x.key} className="flex items-center gap-1">
                  {i > 0 && <span className="text-fg-subtle">→</span>}
                  <Chip title={x.type}>{x.title}</Chip>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
      <FormError>{error}</FormError>
    </>
  );
}
