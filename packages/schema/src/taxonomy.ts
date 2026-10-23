import { z } from "zod";

/** Task taxonomy v1 (docs/ROUTING_AND_QUALITY.md §1). Fixed: scores are kept per type. Add types only with a migration. */
export const TASK_TYPES = [
  "code.feature",
  "code.bugfix",
  "code.refactor",
  "code.tests",
  "code.review",
  "code.migration",
  "code.frontend_ui",
  "code.infra_devops",
  "code.data_pipeline",
  "code.merge_resolve",
  "design.api_contract",
  "design.schema",
  "design.architecture",
  "design.ui_mockup",
  "research.web",
  "research.deep_report",
  "research.market_chatter",
  "research.academic",
  "research.fact_check",
  "write.doc",
  "write.marketing_copy",
  "write.email",
  "write.summary",
  "write.translation_indic",
  "data.analysis",
  "data.extraction",
  "data.sql",
  "media.image",
  "media.video",
  "media.voice",
  "media.music",
  "browser.task",
  "browser.form_fill",
  "browser.scrape_public",
  "plan.decompose",
  "judge.pairwise",
  "review.rubric",
  "merge.integrate",
] as const;

export const TASK_TAXONOMY_VERSION = 1;

export const TaskType = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskType>;

export type TaskGroup = TaskType extends `${infer G}.${string}` ? G : never;

export function taskGroup(type: TaskType): TaskGroup {
  return type.slice(0, type.indexOf(".")) as TaskGroup;
}
