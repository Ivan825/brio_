// pnpm evals — run the golden missions under each routing strategy and print the comparable metrics table.
//   offline (default): simulated agents of known skill (src/sim.ts); no keys, reproducible; what CI runs nightly.
//   --live: your own agents and keys, from --agents <file.json> (EvalAgent[]: name, connector, model, keyEnv…).
// Options: --missions a,b  --strategies learned,static,single:mini  --out <dir>  --timeout-min <n>  --epochs <n>
//          --feedback   (rate each result as its user would, by the hidden checks: the learned router's outcome signal)
//          --save-db <DATABASE_URL> --workspace <id>   (stores the run for the evals dashboard)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderEvalTable } from "@brio/core";
import { createDb, schema } from "@brio/db";
import { evalMissionKeys } from "./golden";
import { type EvalAgent, runEvals } from "./run";
import { SIM_AGENTS, SimVendors } from "./sim";

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    missions: { type: "string" },
    strategies: { type: "string" },
    agents: { type: "string" },
    out: { type: "string", default: join(import.meta.dirname, "..", "results") },
    "timeout-min": { type: "string" },
    "save-db": { type: "string" },
    workspace: { type: "string" },
    notes: { type: "string" },
    epochs: { type: "string" },
    feedback: { type: "boolean", default: false },
  },
});

const missions = values.missions ? values.missions.split(",") : evalMissionKeys();
let agents: EvalAgent[];
let sim: SimVendors | null = null;
if (values.live) {
  if (!values.agents) throw new Error("--live needs --agents <file.json>");
  const raw = JSON.parse(readFileSync(values.agents, "utf8")) as Array<
    Omit<EvalAgent, "apiKey"> & { keyEnv: string }
  >;
  agents = raw.map(({ keyEnv, ...a }) => {
    const apiKey = process.env[keyEnv];
    if (!apiKey) throw new Error(`${a.name}: set ${keyEnv}`);
    return { ...a, apiKey };
  });
} else {
  sim = new SimVendors();
  // Key-shaped placeholders: the simulation never checks them, and real vendors are never called offline.
  const fakeKey = (c: string) => ["sim", c, "0123456789abcdefghijklmnop"].join("-");
  agents = SIM_AGENTS.map((a) => ({
    name: a.name,
    connector: a.connector,
    model: a.model,
    apiKey: fakeKey(a.connector),
    price: a.price,
    ...(a.apiStyle ? { apiStyle: a.apiStyle } : {}),
  }));
}
const strategies = values.strategies
  ? values.strategies.split(",")
  : [...agents.map((a) => `single:${a.name}`), "static", "learned"];

const run = await runEvals({
  mode: values.live ? "live" : "offline",
  missions,
  strategies,
  agents,
  ...(sim ? { fetch: sim.fetch } : {}),
  timeoutMs: Number(values["timeout-min"] ?? (values.live ? 45 : 6)) * 60_000,
  epochs: Number(values.epochs ?? 1),
  feedback: values.feedback,
  onMission: (strategy, m) => {
    if (sim) {
      sim.strategy = strategy;
      sim.mission = m;
    }
  },
  log: (line) => console.log(line),
  ...(values.notes ? { notes: values.notes } : {}),
});

const table = renderEvalTable(run.summaries, run.verdict);
console.log(`\n${table}`);
mkdirSync(values.out, { recursive: true });
const stamp = run.startedAt.replace(/[:.]/g, "-");
writeFileSync(join(values.out, `${stamp}-${run.mode}.json`), `${JSON.stringify(run, null, 2)}\n`);
writeFileSync(
  join(values.out, `${stamp}-${run.mode}.md`),
  `# Eval run ${run.startedAt} (${run.mode})\n\n${table}`,
);
console.log(`results in ${values.out}`);

if (values["save-db"]) {
  if (!values.workspace) throw new Error("--save-db needs --workspace <id>");
  const handle = createDb(values["save-db"]);
  await handle.db.insert(schema.evalRuns).values({ workspaceId: values.workspace, mode: run.mode, run });
  await handle.close();
  console.log("saved to the evals dashboard");
}
