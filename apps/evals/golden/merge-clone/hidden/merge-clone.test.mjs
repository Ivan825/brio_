import assert from "node:assert/strict";
import { test } from "node:test";
import { deepClone } from "../src/clone.mjs";
import { deepMerge } from "../src/merge.mjs";

test("no mutation", () => {
  const a = { x: { y: 1 } };
  deepMerge(a, { x: { z: 2 } });
  assert.deepEqual(a, { x: { y: 1 } });
});
test("arrays replace", () => assert.deepEqual(deepMerge({ l: [1, 2] }, { l: [3] }), { l: [3] }));
test("dates", () => {
  const d = new Date(5);
  const c = deepClone({ d });
  assert.notEqual(c.d, d);
  assert.equal(c.d.getTime(), 5);
});
