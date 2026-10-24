// The site makes claims about Brio; these keep them true. Agent names must be connectors Brio has, numbers must be the
// load test's, and every documentation link must name a file that exists.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENTS,
  CLI,
  CONNECTOR_COUNT,
  HOSTING,
  LINKS,
  MEASURED,
  REPO,
  SERVER_START,
  SHOTS,
  START,
} from "../lib/content";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const registry = (JSON.parse(read("registry/connectors.json")) as { connectors: Array<{ name: string }> })
  .connectors;

describe("the site's claims", () => {
  it("names only agents in the connector registry, and counts them right", () => {
    const names = new Set(registry.map((c) => c.name));
    for (const agent of AGENTS) expect(names, agent).toContain(agent);
    expect(CONNECTOR_COUNT).toBe(registry.length);
  });

  it("quotes the load test's measured numbers", () => {
    const report = read("docs/LOAD_TEST.md");
    for (const m of MEASURED) expect(report, m.label).toContain(m.source);
  });

  it("links only to documents that exist", () => {
    for (const [name, url] of Object.entries(LINKS)) {
      if (url === REPO) continue;
      const path = url.replace(`${REPO}/blob/main/`, "");
      expect(existsSync(new URL(path, root)), `${name}: ${path}`).toBe(true);
    }
  });

  it("gives the self-host commands the guide gives", () => {
    const guide = read("docs/SELF_HOST.md");
    expect(guide).toContain("./setup.sh");
    expect(guide).toContain("docker compose up -d");
    expect(START[0]).toContain(`${REPO}.git`);
  });

  it("describes only CLI commands the CLI has", () => {
    const usage = read("apps/cli/src/commands.ts");
    for (const [cmd] of CLI) expect(usage, cmd).toContain(cmd.replace(' "<goal>"', ""));
  });

  it("shows only screenshots that exist", () => {
    for (const s of SHOTS)
      expect(existsSync(new URL(`../public/shots/${s.file}.jpg`, import.meta.url)), s.file).toBe(true);
  });

  it("gives the server steps the cloud guide gives, and links each hosting option to its guide", () => {
    const guide = read("docs/DEPLOY_CLOUD.md");
    const shown = SERVER_START.join("\n");
    for (const step of [
      "curl -fsSL https://get.docker.com | sudo sh",
      "sudo usermod -aG docker $USER",
      "git clone https://github.com/Ivan825/brio_.git brio",
      "./setup.sh https://",
      "BRIO_SIGNUP_ALLOW",
      "docker compose up -d",
    ]) {
      expect(shown, step).toContain(step);
      expect(guide, step).toContain(step);
    }
    for (const h of HOSTING) expect(LINKS[h.link]).toMatch(/\.md$/);
  });
});
