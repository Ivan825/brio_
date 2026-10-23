import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk } from "../src/chunk.mjs";

test("splits", () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
