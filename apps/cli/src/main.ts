// The brio CLI entry point (BUILD_PLAN M8): login, missions, run, plan, board, approve; and `brio mcp` (M7), the stdio
// MCP server for local MCP clients.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./args";
import { BrioError } from "./client";
import { COMMANDS, type Io, USAGE, UsageError } from "./commands";
import { configPath } from "./config";
import { proxyOptionsFromEnv, runMcpProxy } from "./mcp-proxy";
import { runner } from "./runner";

const args = parseArgs(process.argv.slice(2));
const [command] = args._;

if (command === "mcp") {
  try {
    await runMcpProxy(proxyOptionsFromEnv(), new StdioServerTransport());
  } catch (e) {
    // stdout belongs to the MCP protocol: problems go to stderr.
    process.stderr.write(`brio mcp: ${(e as Error).message}\n`);
    process.exit(1);
  }
} else {
  const run = command === "runner" ? runner : command ? COMMANDS[command] : undefined;
  if (!run || args.flags.help) {
    process.stdout.write(USAGE);
    process.exit(command && !args.flags.help ? 1 : 0);
  }
  const io: Io = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    configPath: configPath(),
    env: process.env,
    tty: Boolean(process.stdout.isTTY),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    width: () => process.stdout.columns ?? 100,
  };
  try {
    await run(args, io);
  } catch (e) {
    const msg =
      e instanceof BrioError && e.status === 401
        ? "your session has ended: run `brio login` again"
        : (e as Error).message;
    process.stderr.write(`brio ${command}: ${msg}\n`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}
