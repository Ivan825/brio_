// The verifier (ROUTING §4): builds a result's checklist from its task's acceptance checks, runs what can be decided at
// once, hands sandbox and network checks to the runner, and has agents from another vendor decide the rest (rubric
// review, fact check, contract review). It never decides the verdict: the orchestrator reads the checklist for that.
import type { AttemptChecks, CheckItem, Dispatch } from "@brio/adapters";
import {
  type Brief,
  citationsPresent,
  conformanceInstructions,
  DEFAULT_CRITERIA,
  diffScope,
  factCheckInstructions,
  findJsonSchema,
  inFootprint,
  type MediaSpec,
  mediaSpec,
  parseFactCheck,
  parseRubric,
  parseVerdict,
  pickReviewer,
  probeMedia,
  rubricInstructions,
  validateAgainstSchema,
} from "@brio/core";
import { type DbOrTx, schema } from "@brio/db";
import { enqueueChecks, runnerOwns } from "@brio/runner";
import { type Actor, type EventType, TaskContract } from "@brio/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { HttpError } from "../http";
import { pokeRunner } from "../runners/hub";
import { missionAgents } from "./agents";
import type { Scoreboard } from "./scoreboard";

const { artifacts, attempts, blobs, contracts, missions, tasks } = schema;

type Mission = typeof missions.$inferSelect;
type Task = typeof tasks.$inferSelect;
type Attempt = typeof attempts.$inferSelect;

export type Emit = (
  db: DbOrTx,
  m: Pick<Mission, "id" | "workspaceId">,
  type: EventType,
  payload: Record<string, unknown>,
  extra?: { taskId?: string; attemptId?: string; actor?: Actor },
) => Promise<unknown>;

export const COMMAND_CHECKS = new Set(["tests", "typecheck", "lint", "build"]);
/** Checks an agent decides (from another vendor than the maker). */
const AGENT_CHECKS = new Set(["rubric_review", "fact_check", "contract_conformance"]);
const TEXT_FILE = /\.(md|mdx|markdown|txt|html?|rst|adoc)$/i;
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|wav|mp3|mp4|mov|m4a)$/i;

const settled = (i: CheckItem) => i.status === "passed" || i.status === "failed";

export class Verifier {
  constructor(
    private readonly ctx: AppContext,
    private readonly emit: Emit,
    private readonly scores: Scoreboard,
  ) {}

  /** The result's artifacts with their bytes: the report, text files, JSON and media. */
  private async files(attemptId: string) {
    return this.ctx.db
      .select({ kind: artifacts.kind, meta: artifacts.meta, bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(eq(artifacts.attemptId, attemptId));
  }

  /** What reviewers and text checks read: the agent's report, the text files it wrote, and its diff. */
  async resultText(attemptId: string, withDiff = true): Promise<string> {
    const rows = await this.files(attemptId);
    const pathOf = (r: (typeof rows)[number]) => String((r.meta as { path?: string }).path ?? "");
    const report = rows.find((r) => r.kind === "report")?.bytes.toString("utf8") ?? "";
    const docs = rows
      .filter((r) => r.kind === "file" && TEXT_FILE.test(pathOf(r)))
      .map((r) => `## ${pathOf(r)}\n\n${r.bytes.toString("utf8")}`);
    const diff = withDiff ? (rows.find((r) => r.kind === "diff")?.bytes.toString("utf8") ?? "") : "";
    return [report, ...docs, diff ? `--- diff ---\n${diff}` : ""].filter(Boolean).join("\n\n");
  }

  private async contractSpec(m: Mission, name: string | undefined) {
    if (!name) return null;
    const [c] = await this.ctx.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.missionId, m.id), eq(contracts.name, name), eq(contracts.status, "active")))
      .orderBy(desc(contracts.createdAt))
      .limit(1);
    return c
      ? { name: c.name, spec: typeof c.spec === "string" ? c.spec : JSON.stringify(c.spec, null, 2) }
      : null;
  }

  /** Builds and stores the checklist (once), decides what it can now, and queues the runner's part. */
  async start(m: Mission, t: Task, a: Attempt, announce = true): Promise<AttemptChecks> {
    const contract = TaskContract.parse(t.contract);
    const rows = await this.files(a.id);
    const pathOf = (r: (typeof rows)[number]) => String((r.meta as { path?: string }).path ?? "");
    const diff = rows.find((r) => r.kind === "diff");
    const changed = ((diff?.meta as { files?: { path: string }[] } | undefined)?.files ?? []).map(
      (f) => f.path,
    );
    const text = [
      rows.find((r) => r.kind === "report")?.bytes.toString("utf8") ?? "",
      ...rows
        .filter((r) => r.kind === "file" && TEXT_FILE.test(pathOf(r)))
        .map((r) => r.bytes.toString("utf8")),
    ].join("\n\n");

    const items: CheckItem[] = [];
    for (const [index, c] of contract.acceptance.entries()) {
      const base: CheckItem = {
        index,
        kind: c.kind,
        hard: c.hard,
        status: "pending",
        ...(c.command ? { command: c.command } : {}),
        ...(c.criteria ? { criteria: c.criteria } : {}),
        ...(c.threshold !== undefined ? { threshold: c.threshold } : {}),
        ...(c.contract ? { contract: c.contract } : {}),
        ...(c.params ? { params: c.params } : {}),
      };
      const p = c.params ?? {};
      switch (c.kind) {
        case "diff_scope": {
          const r = diffScope(changed, contract.expectedFootprint?.paths);
          items.push({
            ...base,
            status: r.passed ? "passed" : "failed",
            summary: r.summary,
            details: r.outside,
          });
          break;
        }
        case "tests":
        case "typecheck":
        case "lint":
        case "build":
        case "a11y":
        case "lighthouse":
          items.push(
            a.worktreeRef
              ? base
              : {
                  ...base,
                  status: "failed",
                  summary: `${c.kind} needs files to check; this task produced none`,
                },
          );
          break;
        case "citation_present": {
          const r = citationsPresent(text, typeof p.minWords === "number" ? { minWords: p.minWords } : {});
          items.push({
            ...base,
            status: r.passed ? "passed" : "failed",
            summary: r.summary,
            details: r.uncited,
          });
          break;
        }
        case "media_spec": {
          const glob = typeof p.path === "string" ? [p.path] : null;
          const media = rows.filter(
            (r) =>
              (r.kind === "file" && (glob ? inFootprint(pathOf(r), glob) : MEDIA_FILE.test(pathOf(r)))) ||
              ["image", "video", "audio"].includes(r.kind),
          );
          if (!media.length) {
            items.push({ ...base, status: "failed", summary: "no media file to check" });
            break;
          }
          const problems = media.flatMap((r) => {
            const probe = probeMedia(new Uint8Array(r.bytes));
            return mediaSpec(probe, p as MediaSpec).problems.map((x) => `${pathOf(r) || r.kind}: ${x}`);
          });
          items.push({
            ...base,
            status: problems.length ? "failed" : "passed",
            summary: problems.length
              ? problems.slice(0, 5).join("; ")
              : `${media.length} media file(s) meet the spec`,
            details: problems,
          });
          break;
        }
        case "contract_conformance": {
          const name = c.contract ?? contract.inputs.find((i) => i.kind === "contract")?.ref;
          const spec = await this.contractSpec(m, name);
          if (!spec) {
            items.push({
              ...base,
              status: "failed",
              summary: `contract ${name ?? "(none named)"} not found`,
            });
            break;
          }
          const schemaDoc = findJsonSchema(spec.spec);
          if (schemaDoc) {
            const docs = Object.fromEntries(
              rows
                .filter((r) => r.kind === "file" && /\.json$/i.test(pathOf(r)))
                .filter((r) => !Array.isArray(p.paths) || inFootprint(pathOf(r), p.paths as string[]))
                .map((r) => [pathOf(r), r.bytes.toString("utf8")]),
            );
            const r = validateAgainstSchema(schemaDoc, docs);
            items.push({
              ...base,
              contract: spec.name,
              status: r.passed ? "passed" : "failed",
              summary: r.summary,
              details: r.errors,
            });
          } else if (c.command) {
            // A command decides it (for example a type check against the contract's types).
            items.push(
              a.worktreeRef
                ? { ...base, contract: spec.name }
                : { ...base, status: "failed", summary: "contract_conformance needs files to check" },
            );
          } else
            items.push({ ...base, contract: spec.name, summary: "an agent from another vendor checks it" });
          break;
        }
        case "fact_check":
          items.push({ ...base, stage: "sources" });
          break;
        case "rubric_review":
          items.push({
            ...base,
            criteria: c.criteria?.length ? c.criteria : DEFAULT_CRITERIA,
            threshold: c.threshold ?? 4,
          });
          break;
        case "link_check":
          items.push(base);
          break;
        default:
          items.push({ ...base, status: "needs_human", summary: "waiting for a person" });
      }
    }

    const checks: AttemptChecks = { requestedAt: new Date().toISOString(), items };
    const [claimed] = await this.ctx.db
      .update(attempts)
      .set({ checks: checks as unknown as Record<string, unknown> })
      .where(and(eq(attempts.id, a.id), isNull(attempts.checks)))
      .returning();
    if (!claimed)
      return ((await this.ctx.db.select().from(attempts).where(eq(attempts.id, a.id)))[0]?.checks ??
        checks) as AttemptChecks;
    for (const i of items.filter(settled))
      await this.emit(
        this.ctx.db,
        m,
        "check.result",
        {
          index: i.index,
          kind: i.kind,
          passed: i.status === "passed",
          summary: i.summary ?? "",
          details: i.details ?? [],
        },
        { taskId: t.id, attemptId: a.id },
      );
    if (announce) await this.announceHuman(m, t, a, items);
    if (
      items.some(
        (i) => runnerOwns(i) || (i.kind === "contract_conformance" && i.command && i.status === "pending"),
      )
    ) {
      await enqueueChecks(this.ctx.queue, a.id);
      // A local runner's attempt: its command checks run on that runner.
      const runnerId = (a.dispatch as { target?: { runnerId?: string } } | null)?.target?.runnerId;
      if (runnerId) await pokeRunner(this.ctx.db, runnerId).catch(() => {});
    }
    return checks;
  }

  async announceHuman(m: Mission, t: Task, a: Attempt, items: CheckItem[], note?: string) {
    const human = items.filter((i) => i.status === "needs_human");
    if (!human.length) return;
    await this.emit(
      this.ctx.db,
      m,
      "approval.requested",
      {
        taskKey: t.key,
        what: "accept this task's result",
        checks: human.map((i) => i.kind),
        reasons: human.map((i) => i.summary ?? ""),
        ...(note ? { note } : {}),
      },
      { taskId: t.id, attemptId: a.id },
    );
  }

  /** Replaces one checklist item under the attempt's row lock; emits its result once it is settled. */
  private async update(
    m: Mission,
    t: Task,
    attemptId: string,
    item: CheckItem,
    only?: (current: CheckItem) => boolean,
  ) {
    return this.ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from attempts where id = ${attemptId} for update`);
      const [row] = await tx
        .select({ checks: attempts.checks })
        .from(attempts)
        .where(eq(attempts.id, attemptId));
      const checks = row?.checks as AttemptChecks | undefined;
      const current = checks?.items.find((i) => i.index === item.index);
      if (!checks || !current || (only && !only(current))) return false;
      checks.items = checks.items.map((i) => (i.index === item.index ? item : i));
      await tx
        .update(attempts)
        .set({ checks: checks as unknown as Record<string, unknown> })
        .where(eq(attempts.id, attemptId));
      if (settled(item))
        await this.emit(
          tx,
          m,
          "check.result",
          {
            index: item.index,
            kind: item.kind,
            passed: item.status === "passed",
            summary: item.summary ?? "",
            details: item.details ?? [],
            ...(item.scores ? { scores: item.scores } : {}),
          },
          { taskId: t.id, attemptId },
        );
      return true;
    });
  }

  private brief(t: Task): Brief {
    const c = TaskContract.parse(t.contract);
    return { title: t.title, objective: c.objective, constraints: c.constraints };
  }

  /**
   * Moves the agent checks along: starts a reviewer from another vendor for each one that is ready, and reads the
   * answers of reviewers that finished. Returns the checklist as it now stands.
   */
  async advance(m: Mission, t: Task, a: Attempt): Promise<AttemptChecks | null> {
    const read = async () =>
      ((await this.ctx.db.select({ checks: attempts.checks }).from(attempts).where(eq(attempts.id, a.id)))[0]
        ?.checks ?? null) as AttemptChecks | null;
    const checks = await read();
    if (!checks) return null;
    const agentItems = checks.items.filter(
      (i) =>
        AGENT_CHECKS.has(i.kind) &&
        (i.status === "pending" || i.status === "running") &&
        !(i.kind === "fact_check" && i.stage !== "review") &&
        !(i.kind === "contract_conformance" && i.command),
    );
    if (!agentItems.length) return checks;

    let reviewerFor:
      | ((kind: string) => Promise<{ ok: true; agentId: string } | { ok: false; reason: string }>)
      | null = null;
    for (const item of agentItems) {
      if (item.status === "pending") {
        reviewerFor ??= await this.reviewerPicker(m, t, a);
        const choice = await reviewerFor(item.kind);
        if (!choice.ok) {
          const ok = await this.update(
            m,
            t,
            a.id,
            { ...item, status: "needs_human", summary: choice.reason },
            (c) => c.status === "pending",
          );
          if (ok)
            await this.announceHuman(m, t, a, [{ ...item, status: "needs_human", summary: choice.reason }]);
          continue;
        }
        // Claim the item before starting anyone, so a second tick cannot start a second reviewer.
        const claimed = await this.update(
          m,
          t,
          a.id,
          {
            ...item,
            status: "running",
            reviewerAgentId: choice.agentId,
            summary: "an agent from another vendor is checking it",
          },
          (c) => c.status === "pending" && !c.reviewAttemptId,
        );
        if (!claimed) continue;
        try {
          const started = await this.ctx.attempts.start({
            workspaceId: m.workspaceId,
            taskId: t.id,
            agentId: choice.agentId,
            actor: "system",
            role: "checker",
            mode: { purpose: "check", of: [a.id], step: 0, checkIndex: item.index },
            sandboxTaskType: "review.rubric",
            rationale: `${item.kind.replaceAll("_", " ")} by another vendor`,
            instructions: await this.instructionsFor(m, t, a, item),
          });
          await this.update(
            m,
            t,
            a.id,
            {
              ...item,
              status: "running",
              reviewerAgentId: choice.agentId,
              reviewAttemptId: started.id,
              summary: "an agent from another vendor is checking it",
            },
            (c) => c.status === "running" && !c.reviewAttemptId,
          );
        } catch (err) {
          const why = err instanceof HttpError ? err.message : (err as Error).message;
          const human = {
            ...item,
            status: "needs_human" as const,
            summary: `could not start a reviewer (${why}); a person reviews instead`,
          };
          if (await this.update(m, t, a.id, human)) await this.announceHuman(m, t, a, [human]);
        }
        continue;
      }
      if (!item.reviewAttemptId) continue;
      const [reviewer] = await this.ctx.db
        .select()
        .from(attempts)
        .where(eq(attempts.id, item.reviewAttemptId));
      if (!reviewer || reviewer.status === "queued" || reviewer.status === "running") continue;
      await this.readReviewer(m, t, a, item, reviewer);
    }
    return read();
  }

  /** Reviewers for this result, best first, never from the maker's vendor (pickReviewer). */
  private async reviewerPicker(m: Mission, t: Task, a: Attempt) {
    const agents = await missionAgents(this.ctx, m);
    const maker = agents.find((x) => x.id === a.agentId);
    const makerVendor =
      maker?.vendor ??
      (a.dispatch as { agent?: { connector?: { presetKey?: string } } } | null)?.agent?.connector
        ?.presetKey ??
      "unknown";
    const contract = TaskContract.parse(t.contract);
    const keys = [...new Set(agents.map((x) => x.scoreKey))];
    const scored = await this.scores.get(m.workspaceId, keys, "review.rubric");
    const ranked = [...agents].sort(
      (x, y) => (scored.get(y.scoreKey)?.elo ?? 1200) - (scored.get(x.scoreKey)?.elo ?? 1200),
    );
    return async (_kind: string) =>
      pickReviewer(
        ranked,
        { agentId: a.agentId, vendor: makerVendor },
        { kind: "review.rubric", confidential: contract.sensitivity === "confidential" },
      );
  }

  private async instructionsFor(m: Mission, t: Task, a: Attempt, item: CheckItem): Promise<string> {
    const brief = this.brief(t);
    if (item.kind === "rubric_review")
      return rubricInstructions(
        brief,
        await this.resultText(a.id),
        item.criteria ?? DEFAULT_CRITERIA,
        item.threshold ?? 4,
      );
    if (item.kind === "fact_check")
      return factCheckInstructions(brief, await this.resultText(a.id, false), item.sources ?? []);
    const spec = await this.contractSpec(m, item.contract);
    return conformanceInstructions(
      brief,
      await this.resultText(a.id),
      spec ?? { name: item.contract ?? "contract", spec: "(missing)" },
    );
  }

  private async readReviewer(m: Mission, t: Task, a: Attempt, item: CheckItem, reviewer: Attempt) {
    const toHuman = async (summary: string) => {
      const human = { ...item, status: "needs_human" as const, summary };
      if (await this.update(m, t, a.id, human, (c) => c.status === "running"))
        await this.announceHuman(m, t, a, [human]);
    };
    if (reviewer.status !== "succeeded")
      return toHuman(
        `the reviewer did not finish (${reviewer.exitReason ?? reviewer.status}); a person reviews instead`,
      );
    const [report] = await this.ctx.db
      .select({ bytes: blobs.bytes })
      .from(artifacts)
      .innerJoin(blobs, and(eq(blobs.workspaceId, artifacts.workspaceId), eq(blobs.sha256, artifacts.sha256)))
      .where(and(eq(artifacts.attemptId, reviewer.id), eq(artifacts.kind, "report")));
    const answer = report?.bytes.toString("utf8") ?? "";
    let next: CheckItem | null = null;
    let verdict: "pass" | "revise" | "fail" = "fail";
    let reasons = "";
    let scores: Record<string, number> = {};
    if (item.kind === "rubric_review") {
      const r = parseRubric(answer, item.criteria ?? DEFAULT_CRITERIA, item.threshold ?? 4);
      if (r) {
        verdict = r.passed ? "pass" : r.verdict === "fail" ? "fail" : "revise";
        reasons = r.reasons;
        scores = r.scores;
        const low = Object.entries(r.scores).filter(([, s]) => s < (item.threshold ?? 4));
        next = {
          ...item,
          status: r.passed ? "passed" : "failed",
          scores: r.scores,
          summary: r.passed
            ? `every criterion ≥ ${item.threshold ?? 4}${r.reasons ? `: ${r.reasons}` : ""}`
            : `${low.map(([c, s]) => `${c} ${s}/5`).join(", ") || "failed by the reviewer"}${r.reasons ? `: ${r.reasons}` : ""}`,
        };
      }
    } else if (item.kind === "fact_check") {
      const r = parseFactCheck(answer);
      if (r) {
        verdict = r.passed ? "pass" : "fail";
        reasons = r.summary;
        next = {
          ...item,
          status: r.passed ? "passed" : "failed",
          summary: r.summary,
          details: r.claims.filter((c) => !c.supported).map((c) => `unsupported: ${c.claim} (${c.why})`),
        };
      }
    } else {
      const r = parseVerdict(answer);
      if (r) {
        verdict = r.verdict === "pass" ? "pass" : "fail";
        reasons = r.reasons;
        next = {
          ...item,
          status: r.verdict === "pass" ? "passed" : "failed",
          summary: r.reasons || r.verdict,
        };
      }
    }
    if (!next) return toHuman("the reviewer's answer could not be read; a person reviews instead");
    const done = await this.update(
      m,
      t,
      a.id,
      next,
      (c) => c.status === "running" && c.reviewAttemptId === reviewer.id,
    );
    if (!done) return;
    await this.ctx.db.insert(schema.reviews).values({
      workspaceId: m.workspaceId,
      taskId: t.id,
      attemptId: a.id,
      reviewerAgentId: reviewer.agentId,
      kind: "review",
      verdict,
      scores,
      reasons: `${item.kind}: ${reasons}`.slice(0, 4000),
      evidence: [{ reviewerAttemptId: reviewer.id, check: item.index }],
    });
  }

  /** Cancels reviewers still working on a result that will not be used (it is being revised or rerouted). */
  async cancelOpen(a: Attempt): Promise<void> {
    const checks = (
      await this.ctx.db.select({ checks: attempts.checks }).from(attempts).where(eq(attempts.id, a.id))
    )[0]?.checks as AttemptChecks | null;
    const ids = (checks?.items ?? []).flatMap((i) =>
      i.status === "running" && i.reviewAttemptId ? [i.reviewAttemptId] : [],
    );
    if (!ids.length) return;
    const open = await this.ctx.db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(inArray(attempts.id, ids), inArray(attempts.status, ["queued", "running"])));
    for (const r of open) await this.ctx.attempts.cancel(r.id, a.workspaceId, "system", 0).catch(() => {});
  }

  /** The dispatch purpose of an attempt (single-mode makers have none). */
  static purpose(a: Pick<Attempt, "dispatch">): string {
    return (a.dispatch as Dispatch | null)?.mode?.purpose ?? "make";
  }
}
