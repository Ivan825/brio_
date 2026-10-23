#!/usr/bin/env node
// Runs the CLI from source through tsx (a dependency of the package), so `pnpm link` or `npx` gives a working `brio`.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
