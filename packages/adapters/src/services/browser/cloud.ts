// Cloud browsers as infrastructure (docs/vendors/research-browser.md §13): a Browserbase or Steel session for computer
// use when an agent asks for one (options.browser = "cloud"), released when the run ends, metered by the seconds it was
// open. Like search, it is a workspace tool, not an agent. The session URL can carry the key (Steel): it stays in
// memory, never in events or logs.
import { AdapterError } from "../../errors";
import type { AgentAdapter, CloudBrowserProvider, CloudBrowserSession } from "../../types";
import { ServiceClient } from "../client";
import { type ToolBinding, type ToolContext, toolAdapter } from "../research/tools";

export interface CloudBrowserVendor {
  key: string;
  create(
    api: ServiceClient,
    o: { width: number; height: number; timeoutS: number },
    secret: string,
  ): Promise<{ id: string; url: string }>;
  release(api: ServiceClient, id: string): Promise<void>;
}

export const browserbase: CloudBrowserVendor = {
  key: "browserbase",
  async create(api, o) {
    const s = await api.json<{ id?: string; connectUrl?: string; status?: string }>(
      "POST",
      "/v1/sessions",
      {
        timeout: Math.max(60, Math.min(21_600, Math.round(o.timeoutS))),
        browserSettings: { viewport: { width: o.width, height: o.height }, blockAds: true },
        userMetadata: { brio: "computer-use" },
      },
      { retries: 0 },
    );
    if (!s.id || !s.connectUrl) throw new AdapterError("bad_request", "Browserbase did not return a session");
    return { id: s.id, url: s.connectUrl };
  },
  async release(api, id) {
    await api.json("POST", `/v1/sessions/${id}`, { status: "REQUEST_RELEASE" }, { retries: 1 });
  },
};

export const steel: CloudBrowserVendor = {
  key: "steel",
  async create(api, o, secret) {
    const s = await api.json<{ id?: string; websocketUrl?: string }>(
      "POST",
      "/v1/sessions",
      {
        timeout: Math.round(o.timeoutS * 1000),
        dimensions: { width: o.width, height: o.height },
        blockAds: true,
      },
      { retries: 0 },
    );
    if (!s.id || !s.websocketUrl) throw new AdapterError("bad_request", "Steel did not return a session");
    // Steel's documented connection puts the key in the URL; it goes no further than this socket.
    const url = new URL(s.websocketUrl);
    url.searchParams.set("apiKey", secret);
    return { id: s.id, url: url.toString() };
  },
  async release(api, id) {
    await api.json("POST", `/v1/sessions/${id}/release`, {}, { retries: 1 });
  },
};

export const CLOUD_BROWSERS: Readonly<Record<string, CloudBrowserVendor>> = { browserbase, steel };

/** Their connector side: key checks like any connector; never run as agents. */
export const CLOUD_BROWSER_ADAPTERS: readonly AgentAdapter[] = Object.values(CLOUD_BROWSERS).map((v) =>
  toolAdapter({ key: v.key, kind: "cloud browser" }),
);

/** Sessions on the workspace's cloud browser connector, each metered by how long it was open. */
export function cloudBrowserProvider(b: ToolBinding, ctx: ToolContext): CloudBrowserProvider {
  const v = CLOUD_BROWSERS[b.connector.service?.adapter ?? ""];
  if (!v) throw new AdapterError("misconfigured", `${b.connector.registryKey} is not a cloud browser`);
  return {
    vendor: v.key,
    async session(o): Promise<CloudBrowserSession> {
      const api = new ServiceClient(b.connector, {
        credential: ctx.credential,
        fetch: ctx.fetch,
        signal: o.signal,
      });
      const started = Date.now();
      const s = await v.create(api, o, ctx.credential?.reveal() ?? "");
      let released = false;
      return {
        url: s.url,
        async release() {
          if (released) return;
          released = true;
          // A release that fails still ends at the session's own timeout.
          await v
            .release(new ServiceClient(b.connector, { credential: ctx.credential, fetch: ctx.fetch }), s.id)
            .catch(() => {});
          const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
          ctx.meter(b.usdPerUnit !== null ? seconds * b.usdPerUnit : 0, `${v.key} browser`);
        },
      };
    },
  };
}
