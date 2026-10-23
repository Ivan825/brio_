import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords } from "../src/words.mjs";

test("apostrophes and hyphens", () => {
  const m = countWords("Don't stop well-known stops!");
  assert.equal(m.get("don't"), 1);
  assert.equal(m.get("well-known"), 1);
  assert.equal(m.get("stops"), 1);
});
test("empty", () => assert.equal(countWords("  ...  ").size, 0));
