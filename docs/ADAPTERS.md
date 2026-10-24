# Writing an adapter

Brio drives agents through one interface, `AgentAdapter` ([ADAPTER_SPEC.md](ADAPTER_SPEC.md)). Most new agents and models need no code at all. Try these first:

| You want Brio to use… | Do this | Code? |
|---|---|---|
| A model behind an OpenAI-compatible API (a new vendor, your own proxy, a local server) | Add a **preset** to `registry/connectors.json` (base URL, auth, model-list shape, pricing), or install the generic OpenAI-compatible connector with your base URL | No |
| A vendor API that starts a job, then polls it or calls back (media, research, hosted agents) | Add a **service** to `registry/connectors.json` (base URL with install settings, auth, health check, billing unit, task types) | No; the shared job runner drives it |
| An agent that speaks **A2A** | Install it from **Connectors → A2A agent** by URL; its card names it and suggests the task types it takes | No |
| Tools from an **MCP** server | Install it by URL and attach it to agents | No |
| A coding CLI, or an API with its own protocol | Write an adapter | Yes |

## The interface

```ts
interface AgentAdapter {
  key: string;            // the adapter key registry entries point at
  route: Route;           // how it is reached: "api", "cli", "hosted", "browser", "a2a", …
  capabilities(config: AgentConfig): AdapterCapabilities;
  healthCheck(config: ConnectorConfig, ctx): Promise<HealthStatus>;   // free where the vendor allows
  listModels?(config: ConnectorConfig, ctx): Promise<ModelInfo[]>;
  estimate(input: RunInput, config: AgentConfig): Promise<{ usd: number; minutes: number }>;
  run(input: RunInput, config: AgentConfig, ctx: RunContext): Promise<RunResult>;
  resume?(vendorRunId: string, message: string, ctx: RunContext): Promise<RunResult>;
}
```

`run` gets the task's input (instructions, contract, handoffs, attachments, the project's memory brief) and a context:
- `ctx.fetch` is guarded: no private networks or cloud metadata unless the deployment allows them, and DNS is pinned.
- `ctx.credential` is the vault secret, revealed only in memory.
- `ctx.sandbox` is the attempt's container, for files and processes.
- `ctx.emit` reports progress, tool calls, file edits and cost.
- `ctx.tools` holds the workspace's search, page fetch and the mailbox (for asking other agents or the person a question).
- `ctx.signal` is cancellation, which you must honour.
- Limits on cost, time and tokens are enforced: throw `LimitExceeded` when you pass one.

Return a `RunResult` with the output, the files produced, usage and cost.

**Rules every adapter keeps** (CLAUDE.md, [SECURITY_GOVERNANCE.md](SECURITY_GOVERNANCE.md)):
1. Official APIs, CLIs and SDKs only, with the person's own keys or sign-in. Never a consumer chat UI, and never another tool's stored tokens.
2. Every side effect is reported through `ctx.emit`.
3. Secrets never reach events, logs or prompts sent to other vendors. The redactor scrubs what passes through.
4. Code runs in `ctx.sandbox`, never on the runner's host.
5. Model names come from the vendor's model list, never from code.
6. Untrusted text you pass on to a model goes in `untrustedBlock` (from `@brio/core`).

## Steps

1. **Registry entry.** Add or verify the connector in `registry/connectors.json`:
   - its route and how to connect;
   - its docs URL and the date you verified them;
   - `plannedAdapter` naming your adapter's key.

   `packages/registry` checks that every planned adapter resolves.
2. **Implement.** Put your adapter in `packages/adapters/src/<family>/`. Start from the closest one: an API family (`families/`), `cli/base.ts` for coding CLIs, or `services/job.ts` for start-and-poll vendors.
3. **Register.** Add it to `ADAPTERS` in `packages/adapters/src/index.ts`.
4. **Fixtures.** Record real responses, with keys removed, under `packages/adapters/test/fixtures/`.
5. **Contract suite.** Call `defineAdapterContract({...})` from `packages/adapters/test/contract.ts` with your adapter and fixtures. It checks:
   - the health check;
   - the estimate;
   - the hello task;
   - the tool loop;
   - cancelling mid-run;
   - a limit breach;
   - that a planted credential never appears in events or logs.
6. **Pricing.** Give the preset its prices (or a model-list shape that carries them), with a source and date.
7. **Live test (optional).** Write one gated by `LIVE_<VENDOR>=1`. It runs only with the owner's keys, never in PR CI.
8. **Connector page copy.** Write how a person connects it, in the registry entry's `howToConnect`.

Run `pnpm typecheck && pnpm lint && pnpm test`. A new adapter starts every routing decision with a neutral prior, Beta(1,1), and earns its place on the scoreboard.
