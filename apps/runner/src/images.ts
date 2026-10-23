// Sandbox images, built from apps/runner/images on first use. Default tags carry a hash of the image's source, so a
// changed Dockerfile or proxy always gets a fresh build. Deployments can pin pushed images instead (BRIO_IMAGE_*).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { docker, imageExists } from "./docker";

export interface ImageSet {
  base: string;
  cli: string;
  proxy: string;
  /** Chromium, Lighthouse and axe-core for the a11y and lighthouse checks. */
  web: string;
}

const IMAGES_DIR = join(import.meta.dirname, "..", "images");

const SOURCES: Record<keyof ImageSet, string> = {
  base: "sandbox-base",
  cli: "sandbox-cli",
  proxy: "egress-proxy",
  web: "sandbox-web",
};

function sourceHash(dir: string, extra = ""): string {
  const h = createHash("sha256").update(extra);
  for (const f of readdirSync(join(IMAGES_DIR, dir)).sort())
    h.update(f).update(readFileSync(join(IMAGES_DIR, dir, f)));
  return h.digest("hex").slice(0, 12);
}

export function defaultImages(): ImageSet {
  const base = `brio/sandbox-base:${sourceHash(SOURCES.base)}`;
  return {
    base,
    cli: `brio/sandbox-cli:${sourceHash(SOURCES.cli, base)}`,
    proxy: `brio/egress-proxy:${sourceHash(SOURCES.proxy)}`,
    web: `brio/sandbox-web:${sourceHash(SOURCES.web, base)}`,
  };
}

export const DEFAULT_IMAGES: ImageSet = defaultImages();

/** Builds an image from apps/runner/images/<dir> unless the tag already exists. */
export async function ensureImage(images: ImageSet, which: keyof ImageSet): Promise<string> {
  const tag = images[which];
  if (await imageExists(tag)) return tag;
  const args = ["build", "-q", "-t", tag];
  if (which === "cli" || which === "web") {
    await ensureImage(images, "base");
    args.push("--build-arg", `BASE=${images.base}`);
  }
  await docker([...args, join(IMAGES_DIR, SOURCES[which])], { timeoutMs: 30 * 60_000 });
  return tag;
}
