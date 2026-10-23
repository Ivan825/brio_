import assert from "node:assert/strict";
import { test } from "node:test";
import { deepMerge } from "../src/merge.mjs";

test("nested", () => assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: { y: 2 } }), { a: { x: 1, y: 2 } }));
