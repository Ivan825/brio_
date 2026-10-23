// brio-mailbox over MCP (ADAPTER_SPEC §2.6, §2.9): a coding CLI gets the workspace's search and fetch tools beside the
// mailbox, only with its own attempt's token, and only the tools the workspace has.
import type { FetchProvider, Mailbox, SearchProvider } from "@brio/adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailboxMcpServer } from "../src/mailbox-mcp";

const mailbox: Mailbox = {
  askAgent: async () => "",
  askUser: async () => null,
  inbox: async () => [],
  answer: async () => {},
  reportBlocker: async () => {},
  requestReview: async () => {},
  reportProgress: async () => {},
  getContract: async () => "",
  getBrief: async () => "brief",
};

const searched: string[] = [];
const search: SearchProvider = {
  search: async (q, { limit }) => {
    searched.push(q);
    return [{ title: "Brio", url: "https://brio.dev", snippet: `top ${limit}` }];
  },
};
const fetcher: FetchProvider = {
  fetch: async (url) => ({ url, title: "Brio", content: "# Brio\nThe conductor.", status: 200 }),
};

async function connect(server: MailboxMcpServer, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("brio-mailbox MCP server", () => {
  const server = new MailboxMcpServer();
  beforeAll(() => server.start());
  afterAll(() => server.stop());

  it("offers web_search and fetch_url when the workspace has them", async () => {
    const research: { search?: SearchProvider; fetch?: FetchProvider } = {};
    const token = server.register(mailbox, research);
    // Filled after registration, as the runner does once it can meter them.
    research.search = search;
    research.fetch = fetcher;
    const client = await connect(server, token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_brief", "web_search", "fetch_url"]));
    const found = await client.callTool({ name: "web_search", arguments: { query: "brio", limit: 2 } });
    expect(textOf(found)).toBe("1. Brio\n   https://brio.dev\n   top 2");
    expect(searched).toEqual(["brio"]);
    const page = await client.callTool({ name: "fetch_url", arguments: { url: "https://brio.dev" } });
    expect(textOf(page)).toBe("# Brio\nhttps://brio.dev\n\n# Brio\nThe conductor.");
    await client.close();
    server.revoke(token);
  });

  it("offers only the mailbox without them, and nothing to an unknown token", async () => {
    const token = server.register(mailbox);
    const client = await connect(server, token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("fetch_url");
    await client.close();
    server.revoke(token);
    await expect(connect(server, token)).rejects.toThrow();
  });
});
