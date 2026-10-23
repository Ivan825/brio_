import assert from "node:assert/strict";
import { test } from "node:test";
import { LRU } from "../src/lru.mjs";

test("evicts", () => {
  const c = new LRU(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("c"), 3);
});
