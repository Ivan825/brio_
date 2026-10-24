// The connector registry, read when the site is built, so the connectors the site lists are the ones Brio has.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./docs";

interface Connector {
  id: string;
  name: string;
  maker: string;
  category: string;
  routes: string[];
  supported?: boolean;
}

/** Category keys in registry/connectors.json, named as docs/CONNECTORS.md's headings name them, in its order. */
export const CATEGORIES = [
  { key: "frontier", label: "Frontier model APIs" },
  { key: "open", label: "Open-weight & regional models" },
  { key: "gateway", label: "Gateways & clouds" },
  { key: "coding", label: "Coding agents" },
  { key: "hosted", label: "Hosted agent runtimes" },
  { key: "browser", label: "Computer-use & browser agents" },
  { key: "research", label: "Research & search" },
  { key: "general", label: "General autonomous agents" },
  { key: "media", label: "Image, video, voice & music" },
  { key: "design", label: "Design & workspace tools" },
  { key: "enterprise", label: "Enterprise agent platforms" },
  { key: "proto", label: "Protocols & frameworks" },
  { key: "hub", label: "Automation & app hubs" },
] as const;

export function connectors(): Connector[] {
  const file = join(process.cwd(), "..", "..", "registry", "connectors.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { connectors: Connector[] }).connectors;
}

/** Each category with its connectors' names, in registry order. */
export function byCategory() {
  const all = connectors();
  return CATEGORIES.map((c) => ({
    ...c,
    slug: slugify(c.label),
    names: all.filter((x) => x.category === c.key).map((x) => x.name),
  }));
}
