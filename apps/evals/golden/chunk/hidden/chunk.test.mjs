import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk } from "../src/chunk.mjs";

test("bad size", () => assert.throws(() => chunk([1], 0), RangeError));
test("bigger than the array", () => assert.deepEqual(chunk([1, 2], 5), [[1, 2]]));
test("empty", () => assert.deepEqual(chunk([], 3), []));
