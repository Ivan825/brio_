// Amazon Nova Act (docs/vendors/protocols.md §4, read from the official SDK and AWS service model): the AWS service
// API (SigV4) plans browser actions step by step; Brio runs them on Chromium in the attempt's browser sandbox (kiosk
// mode, so the screen is the viewport) through brio-cdp, and answers each step with the call results and a viewport
// observation. A human approval goes to the mission's person; a UI takeover (sign-in, captcha) is refused. Billed by
// the agent-hour, metered by the second.
import { browseHostsOf } from "@brio/core";
import { AdapterError, isLimitAbort } from "../../errors";
import type { AgentAdapter, ProducedFile, RunInput, RunResult, SandboxHandle } from "../../types";
import { ServiceClient } from "../client";
import { QUESTION_WAIT_MS } from "../job";
import { CLOSE_BROWSER, sh } from "./actuator";
import { BROWSER_RULES, browserCapabilities } from "./browser-use";
import { startUrl } from "./computer-use";

/** The viewport the model was trained on (the SDK accepts ±20%). */
export const VIEWPORT = { width: 1600, height: 813 };

/** What Nova Act's calls need from a browser, in viewport CSS pixels. */
export interface NovaBrowser {
  open(url: string | null): Promise<void>;
  /** The observation JSON text the service expects (activeURL, dimensions, a JPEG data URL…). */
  observe(): Promise<string>;
  click(x: number, y: number, kind: "left" | "left-double" | "right"): Promise<void>;
  hover(x: number, y: number): Promise<void>;
  scroll(direction: string, x: number, y: number): Promise<void>;
  type(x: number, y: number, text: string, enter: boolean): Promise<void>;
  goto(url: string): Promise<void>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** The sandbox's browser through brio-cdp (image sandbox-browser). */
export function sandboxNovaBrowser(sandbox: SandboxHandle): NovaBrowser {
  const run = async (cmd: string, timeoutMs = 60_000) => {
    const r = await sandbox.exec(cmd, { timeoutMs });
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300) || `exit ${r.exitCode}`);
    return r.stdout;
  };
  const n = (v: number) => String(Math.round(v));
  return {
    async open(url) {
      if (!sandbox.available) throw new Error("Nova Act needs the browser sandbox");
      await run(
        `brio-browser ${VIEWPORT.width} ${VIEWPORT.height} ${sh(url ?? "about:blank")} kiosk`,
        90_000,
      );
    },
    observe: () => run("brio-cdp observe"),
    click: async (x, y, kind) => void (await run(`brio-cdp click ${n(x)} ${n(y)} ${kind}`)),
    hover: async (x, y) => void (await run(`brio-cdp hover ${n(x)} ${n(y)}`)),
    scroll: async (d, x, y) => void (await run(`brio-cdp scroll ${sh(d)} ${n(x)} ${n(y)}`)),
    type: async (x, y, text, enter) =>
      void (await run(
        `brio-cdp type ${n(x)} ${n(y)} ${enter ? 1 : 0} ${Buffer.from(text).toString("base64")}`,
      )),
    goto: async (url) => void (await run(`brio-cdp goto ${sh(url)}`)),
    settle: async () => void (await run("brio-cdp settle")),
    close: async () => void (await sandbox.exec(CLOSE_BROWSER, { timeoutMs: 10_000 }).catch(() => {})),
  };
}

/**
 * The point to act on: the centre of `<box>top,left,bottom,right</box>` (viewport pixels) or of
 * `<bbox>left,top,right,bottom</bbox>` / a bare list (0–1000, scaled to the viewport).
 */
export function boxCentre(box: unknown, viewport = VIEWPORT): [number, number] {
  if (typeof box !== "string") throw new Error("the box must be a string");
  const b = box.trim();
  const px =
    /^<box>\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\s*<\/box>$/.exec(b);
  if (px) {
    const [top, left, bottom, right] = px.slice(1).map(Number) as [number, number, number, number];
    return [(left + right) / 2, (top + bottom) / 2];
  }
  const inner = b.replace(/^<bbox>|<\/bbox>$/g, "");
  const parts = inner.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 1000))
    throw new Error(`not a box: ${b.slice(0, 80)}`);
  const [l, t, r, bt] = parts as [number, number, number, number];
  return [((l + r) / 2) * (viewport.width / 1000), ((t + bt) / 2) * (viewport.height / 1000)];
}

/** The human-in-the-loop tools as the SDK declares them (the model was trained on these descriptions). */
export const HUMAN_TOOLS = [
  {
    name: "human_Approve",
    description:
      "Use this tool to request human approval to complete tasks such as financial transactions, cart checkout or sensitive form submissions when the task requires it.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "clear instructions to the human on what needs to be approved",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    name: "human_UiTakeover",
    description:
      "Use this tool to request the human to take over the UI to complete a step, such as logging in, captcha, or filling sensitive information.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "clear instructions on what actions need to be completed by the human",
          },
        },
        required: ["message"],
      },
    },
  },
];

type Call = { callId: string; name: string; input: unknown };
type CallResult = { callId: string; content: Array<{ text: string }> };

class ActEnded extends Error {
  constructor(
    readonly ok: boolean,
    message: string,
    readonly value?: unknown,
  ) {
    super(message);
  }
}

const NO_UI_TAKEOVER =
  "a person would have to take over the browser (sign-in, captcha or sensitive details), which Brio does not do";

export function createNovaAct(makeBrowser: (sandbox: SandboxHandle) => NovaBrowser): AgentAdapter {
  return {
    key: "nova-act",
    route: "browser",
    capabilities: browserCapabilities(),
    healthCheck: (config, ctx) => new ServiceClient(config, ctx).check(),
    async estimate(input) {
      return { usd: 0.2, minutes: Math.min(input.limits.maxMinutes, 15) };
    },

    async run(input: RunInput, config, ctx): Promise<RunResult> {
      const started = performance.now();
      const api = new ServiceClient(config.connector, {
        credential: ctx.credential,
        fetch: ctx.fetch,
        signal: ctx.signal,
      });
      const said: string[] = [];
      const files: ProducedFile[] = [];
      let usd = 0;
      const perSecond = config.unitPrice?.usd ?? 0;
      const meter = () => {
        const total = ((performance.now() - started) / 1000) * perSecond;
        if (total > usd) {
          ctx.emit({ kind: "cost", usd: total - usd, model: config.model, priceSource: "table" });
          usd = total;
        }
        if (usd > input.limits.maxCostUsd)
          throw new ActEnded(false, `spent $${usd.toFixed(2)}, over the $${input.limits.maxCostUsd} limit`);
      };
      const zero = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      };
      const result = (status: RunResult["status"], extra: Partial<RunResult> = {}): RunResult => ({
        status,
        summary: said.at(-1)?.slice(0, 600) ?? "",
        output: said.join("\n\n"),
        artifacts: [],
        files,
        usage: { usd, tokensIn: 0, tokensOut: 0, seconds: Math.round((performance.now() - started) / 1000) },
        tokens: zero,
        ...extra,
      });

      const definition = String(config.connector.settings?.workflow || "brio");
      if (!/^[a-zA-Z0-9-_]{1,40}$/.test(definition))
        return result("failed", { error: "the workflow name may use letters, digits, - and _" });
      const browser = makeBrowser(ctx.sandbox);
      let runPath = "";
      let actPath = "";
      try {
        await browser.open(startUrl(input));
        // The definition must exist; another run may have made it already.
        await api
          .json("PUT", "/workflow-definitions", { name: definition }, { retries: 1 })
          .catch((e: AdapterError) => {
            if (e.status !== 409) throw e;
          });
        const run = await api.json<{ workflowRunId: string }>(
          "PUT",
          `/workflow-definitions/${definition}/workflow-runs`,
          { modelId: config.model || "nova-act-latest", clientInfo: { compatibilityVersion: 1 } },
          { retries: 0 },
        );
        runPath = `/workflow-definitions/${definition}/workflow-runs/${run.workflowRunId}`;
        ctx.emit({ kind: "vendor_run", id: run.workflowRunId });
        const session = await api.json<{ sessionId: string }>(
          "PUT",
          `${runPath}/sessions`,
          {},
          { retries: 0 },
        );
        const hosts = browseHostsOf(input.contract).filter((h) => !h.startsWith("."));
        const task = [
          config.rolePrompt,
          input.instructions,
          `Rules: ${BROWSER_RULES}${hosts.length ? ` The sites you may use: ${hosts.join(", ")}.` : ""}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const act = await api.json<{ actId: string }>(
          "PUT",
          `${runPath}/sessions/${session.sessionId}/acts`,
          { task: task.slice(0, 10_000), toolSpecs: HUMAN_TOOLS },
          { retries: 0 },
        );
        actPath = `${runPath}/sessions/${session.sessionId}/acts/${act.actId}`;

        let results: CallResult[] = [
          { callId: "initiateAct", content: [{ text: "{}" }] },
          { callId: "takeObservation", content: [{ text: await browser.observe() }] },
        ];
        let previous: string | undefined;
        const maxSteps = input.limits.maxTurns ?? 60;
        for (let step = 0; step < maxSteps; step++) {
          if (ctx.signal.aborted) throw ctx.signal.reason ?? new AdapterError("cancelled", "cancelled");
          const r = await api.json<{ stepId: string; calls?: Call[] }>(
            "PUT",
            `${actPath}/invoke-step/`,
            { callResults: results, ...(previous ? { previousStepId: previous } : {}) },
            { retries: 1, timeoutMs: 5 * 60_000 },
          );
          previous = r.stepId;
          results = [];
          for (const call of r.calls ?? []) {
            const name = call.name.replace(/^(browser|tool)\./, "");
            ctx.emit({
              kind: "tool_call",
              name: `nova.${name}`,
              args: name === "agentType" ? { text: "(typed text)" } : call.input,
            });
            const out = await perform(name, call.input).then(
              (v) => ({ ok: true as const, text: JSON.stringify(v ?? null) }),
              (e: Error) => {
                if (e instanceof ActEnded) throw e;
                return { ok: false as const, text: `${e.name || "Error"}: ${e.message}` };
              },
            );
            results.push({ callId: call.callId, content: [{ text: out.text }] });
            // As the SDK does: the first failing call ends the act.
            if (!out.ok) throw new ActEnded(false, out.text);
          }
          meter();
        }
        throw new ActEnded(false, `stopped after ${maxSteps} steps without finishing`);
      } catch (e) {
        const ended =
          e instanceof ActEnded
            ? e
            : ctx.signal.aborted
              ? new ActEnded(false, (ctx.signal.reason as Error | undefined)?.message ?? "cancelled")
              : new ActEnded(false, (e as Error).message);
        if (actPath)
          await api
            .json(
              "PUT",
              actPath,
              ended.ok
                ? { status: "SUCCEEDED" }
                : { status: "FAILED", error: { message: ended.message.slice(0, 500) } },
              { retries: 1 },
            )
            .catch(() => {});
        if (runPath)
          await api
            .json("PUT", runPath, { status: ended.ok ? "SUCCEEDED" : "FAILED" }, { retries: 1 })
            .catch(() => {});
        try {
          meter();
        } catch {}
        const shot = await browser.observe().catch(() => "");
        const jpeg = /"screenshotBase64":"data:image\/jpeg;base64,([^"]+)"/.exec(shot)?.[1];
        if (jpeg)
          files.push({
            kind: "image",
            name: "final-screen.jpg",
            contentType: "image/jpeg",
            bytes: new Uint8Array(Buffer.from(jpeg, "base64")),
          });
        await browser.close().catch(() => {});
        if (ended.ok) {
          const v = ended.value;
          said.push(
            v === undefined || v === null ? "Done." : typeof v === "string" ? v : JSON.stringify(v, null, 2),
          );
          return result("completed", { vendorRunId: runPath.split("/").pop() ?? "" });
        }
        if (ctx.signal.aborted)
          return result(isLimitAbort(ctx.signal) ? "limit_exceeded" : "cancelled", { error: ended.message });
        if (/over the \$[\d.]+ limit/.test(ended.message))
          return result("limit_exceeded", { error: ended.message });
        return result("failed", { error: ended.message });
      }

      /** One call: a browser action, an observation, a human tool, or the end of the act. */
      async function perform(name: string, input: unknown): Promise<unknown> {
        const args = Array.isArray(input) ? input : [];
        const dict = (input && !Array.isArray(input) && typeof input === "object" ? input : {}) as Record<
          string,
          unknown
        >;
        switch (name) {
          case "agentClick": {
            const [x, y] = boxCentre(args[0]);
            const t = args[1];
            const kind = (typeof t === "object" && t ? (t as { clickType?: string }).clickType : t) ?? "left";
            if (kind !== "left" && kind !== "left-double" && kind !== "right")
              throw new Error(`unknown click type ${kind}`);
            return browser.click(x, y, kind);
          }
          case "agentHover": {
            const [x, y] = boxCentre(args[0]);
            return browser.hover(x, y);
          }
          case "agentScroll": {
            const [x, y] =
              args[1] !== undefined ? boxCentre(args[1]) : [VIEWPORT.width / 2, VIEWPORT.height / 2];
            return browser.scroll(String(args[0]), x, y);
          }
          case "agentType": {
            const [x, y] = boxCentre(args[1]);
            const e = args[2];
            const enter =
              typeof e === "object" && e ? Boolean((e as { pressEnter?: boolean }).pressEnter) : Boolean(e);
            return browser.type(x, y, String(args[0] ?? ""), enter);
          }
          case "goToUrl": {
            const url = String(args[0] ?? "");
            return browser.goto(url);
          }
          case "wait": {
            const s = Number(args[0] ?? 0);
            if (!Number.isFinite(s) || s <= 0) return browser.settle();
            await new Promise((r) => setTimeout(r, Math.min(s, 60) * 1000));
            return null;
          }
          case "waitForPageToSettle":
            return browser.settle();
          case "takeObservation":
            return JSON.parse(await browser.observe());
          case "think":
            if (typeof args[0] === "string" && args[0].trim())
              ctx.emit({ kind: "progress", note: args[0].slice(0, 500) });
            return null;
          case "return":
            throw new ActEnded(true, "returned", args[0]);
          case "throw":
          case "throwAgentError":
            throw new ActEnded(false, String(args[0] ?? "Nova Act gave up"));
          case "human_Approve": {
            const message = String(dict.message ?? "").slice(0, 2000);
            ctx.emit({ kind: "needs_input", question: message });
            const reply = ctx.tools?.mailbox
              ? await ctx.tools.mailbox.askUser(
                  `Nova Act asks for approval: ${message}\nReply yes to approve; anything else (or no answer) declines.`,
                  { waitMs: QUESTION_WAIT_MS },
                )
              : null;
            if (reply && /^\s*(y|yes|approve|approved|ok|okay|go ahead)\b/i.test(reply)) return "yes";
            throw new ActEnded(false, `not approved: ${message}`);
          }
          case "human_UiTakeover":
            throw new ActEnded(false, NO_UI_TAKEOVER);
          default:
            throw new Error(`unknown call ${name}`);
        }
      }
    },
  };
}

export const novaAct = createNovaAct(sandboxNovaBrowser);
