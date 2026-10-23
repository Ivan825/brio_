import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords } from "../src/words.mjs";

test("counts", () => {
  const m = countWords("The cat, the hat.");
  assert.equal(m.get("the"), 2);
  assert.equal(m.get("hat"), 1);
});
