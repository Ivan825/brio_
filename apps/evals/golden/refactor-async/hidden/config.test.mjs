import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULTS, readConfig } from "../src/config.mjs";

test("missing", async () => assert.rejects(readConfig("/tmp/brio-nope.json")));
test("invalid", async () => {
  writeFileSync("/tmp/brio-bad.json", "{");
  await assert.rejects(readConfig("/tmp/brio-bad.json"));
});
test("defaults kept", () => assert.equal(DEFAULTS.port, 3000));
