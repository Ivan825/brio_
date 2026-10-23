import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupe } from "../src/dedupe.mjs";

test("order", () => assert.deepEqual(dedupe([3, 1, 3, 2]), [3, 1, 2]));
