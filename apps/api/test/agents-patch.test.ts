// Editing an agent changes only what is sent: a rename keeps its prompt, limits, options, tags, tools and price.
import { hasTestDatabase } from "@brio/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Harness, startHarness } from "./helpers";
import { ScriptedVendors } from "./vendors";

const OPENAI_KEY = ["sk", "proj", "patch0123456789abcdefghij"].join("-");

describe.skipIf(!hasTestDatabase)("agent edits", () => {
  let h: Harness;
  let c: Client;
  beforeAll(async () => {
    h = await startHarness({ runner: false, fetch: new ScriptedVendors(() => ({ text: "ok" })).fetch });
    c = new Client(h);
    await c.signIn("patch@example.com");
    await c.request("POST", "/v1/workspaces", { name: "Patch" });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("keeps every field that is not sent", async () => {
    const openai = (
      await c.request("POST", "/v1/connectors", { registryKey: "openai-api", apiKey: OPENAI_KEY })
    ).json().connector;
    const price = { inputPerM: 1, outputPerM: 2, cachedInputPerM: null, cacheWritePerM: null };
    const made = (
      await c.request("POST", "/v1/agents", {
        connectorId: openai.id,
        name: "writer",
        model: "gpt-w",
        rolePrompt: "You write crisp release notes.",
        limits: { maxCostUsd: 2 },
        options: { temperature: 0.2 },
        tags: ["docs"],
        priceOverride: price,
      })
    ).json().agent;
    const res = await c.request("PATCH", `/v1/agents/${made.id}`, { name: "notes writer" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().agent).toMatchObject({
      name: "notes writer",
      rolePrompt: "You write crisp release notes.",
      limits: { maxCostUsd: 2 },
      options: { temperature: 0.2 },
      tags: ["docs"],
      priceOverride: price,
      runnerId: null,
    });
  });
});
