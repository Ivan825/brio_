import assert from "node:assert/strict";
import { test } from "node:test";
import { page } from "../src/page.mjs";

const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
test("last partial", () => assert.deepEqual(page(xs, 4, 3), [10]));
test("past the end", () => assert.deepEqual(page(xs, 9, 3), []));
