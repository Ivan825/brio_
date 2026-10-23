import assert from "node:assert/strict";
import { test } from "node:test";
import { LRU } from "../src/lru.mjs";

test("get refreshes", () => {
  const c = new LRU(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), undefined);
});
test("update keeps size", () => {
  const c = new LRU(1);
  c.set("a", 1);
  c.set("a", 2);
  assert.equal(c.get("a"), 2);
});
