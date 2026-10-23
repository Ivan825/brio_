import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("documented", () => assert.match(readFileSync("README.md", "utf8"), /least recently used/i));
