// The coding-CLI adapters (ADAPTER_SPEC §2.3). Each runs its vendor's official CLI headless inside the sandbox.
import { aider } from "./aider";
import { antigravity } from "./antigravity";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { cursorAgent } from "./cursor-agent";
import { goose } from "./goose";
import { opencode } from "./opencode";

export const CLI_ADAPTERS = [claudeCode, codex, cursorAgent, antigravity, opencode, aider, goose] as const;
export { aider, antigravity, claudeCode, codex, cursorAgent, goose, opencode };
