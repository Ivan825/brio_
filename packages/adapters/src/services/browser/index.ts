// Browser agents (ADAPTER_SPEC §2.7): Claude computer use on a browser in Brio's own sandbox, and Browser Use's cloud.
import type { AgentAdapter } from "../../types";
import { browserUse } from "./browser-use";
import { computerUse } from "./computer-use";

export const BROWSER_ADAPTERS: readonly AgentAdapter[] = [computerUse, browserUse];

export { type Actuator, type Screen, sandboxActuator, xdotool } from "./actuator";
export { BROWSER_RULES } from "./browser-use";
export { createComputerUse, pruneScreenshots, startUrl, TOOLSET } from "./computer-use";
