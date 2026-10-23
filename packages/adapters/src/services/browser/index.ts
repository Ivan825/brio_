// Browser agents (ADAPTER_SPEC §2.7): Claude computer use on a browser in Brio's own sandbox or a cloud browser
// (Browserbase, Steel), Amazon Nova Act on the sandbox's browser, and Browser Use's cloud.
import type { AgentAdapter } from "../../types";
import { browserUse } from "./browser-use";
import { CLOUD_BROWSER_ADAPTERS } from "./cloud";
import { computerUse } from "./computer-use";
import { novaAct } from "./nova-act";

export const BROWSER_ADAPTERS: readonly AgentAdapter[] = [
  computerUse,
  browserUse,
  novaAct,
  ...CLOUD_BROWSER_ADAPTERS,
];

export { type Actuator, type Screen, sandboxActuator, xdotool } from "./actuator";
export { BROWSER_RULES } from "./browser-use";
export { Cdp, type Connect, cdpActuator, keyOf, type WsLike } from "./cdp";
export { browserbase, CLOUD_BROWSERS, type CloudBrowserVendor, cloudBrowserProvider, steel } from "./cloud";
export { actuatorFor, createComputerUse, pruneScreenshots, startUrl, TOOLSET } from "./computer-use";
export {
  boxCentre,
  createNovaAct,
  HUMAN_TOOLS,
  type NovaBrowser,
  sandboxNovaBrowser,
  VIEWPORT,
} from "./nova-act";
