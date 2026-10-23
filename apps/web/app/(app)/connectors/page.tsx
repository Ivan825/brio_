import type { Metadata } from "next";
import { serverApi } from "@/lib/server-api";
import type { Catalogue, InstalledConnector } from "@/lib/types";
import { CatalogueView, InstalledList } from "./connector-ui";

export const metadata: Metadata = { title: "Connectors" };

export default async function Page() {
  const [catalogue, installed] = await Promise.all([
    serverApi<Catalogue>("/v1/registry"),
    serverApi<{ connectors: InstalledConnector[] }>("/v1/connectors"),
  ]);
  const connectors = installed.data?.connectors ?? [];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-fg-muted">connectors</p>
        <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
        <p className="max-w-3xl text-fg-muted">
          How Brio reaches models and agents: official APIs with your own keys. Keys go into the vault and
          never into logs, events or prompts.
        </p>
      </header>
      <InstalledList connectors={connectors} />
      {catalogue.data && <CatalogueView catalogue={catalogue.data} />}
    </div>
  );
}
