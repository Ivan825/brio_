import assert from "node:assert/strict";
import { test } from "node:test";
import { deepClone } from "../src/clone.mjs";

test("deep", () => {
  const o = { a: { b: [1] } };
  const c = deepClone(o);
  c.a.b.push(2);
  assert.deepEqual(o.a.b, [1]);
});
