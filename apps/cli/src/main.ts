// The brio CLI entry point. M7: `brio mcp` (stdio MCP server). The rest of the CLI arrives in M8 (docs/BUILD_PLAN.md).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { proxyOptionsFromEnv, runMcpProxy } from "./mcp-proxy";

const [command] = process.argv.slice(2);

switch (command) {
  case "mcp": {
    try {
      await runMcpProxy(proxyOptionsFromEnv(), new StdioServerTransport());
    } catch (e) {
      // stdout belongs to the MCP protocol: problems go to stderr.
      process.stderr.write(`brio mcp: ${(e as Error).message}\n`);
      process.exit(1);
    }
    break;
  }
  default:
    process.stderr.write("usage: brio mcp   (more commands arrive in M8)\n");
    process.exit(command ? 1 : 0);
}
