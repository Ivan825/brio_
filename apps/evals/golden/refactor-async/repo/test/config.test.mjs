import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { readConfig } from "../src/config.mjs";

test("reads", async () => {
  writeFileSync("/tmp/brio-cfg.json", '{"port":1}');
  assert.deepEqual(await readConfig("/tmp/brio-cfg.json"), { port: 1 });
});
