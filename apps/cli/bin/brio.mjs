#!/usr/bin/env node
// Runs the CLI from source through tsx until M8 ships a bundled binary.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
