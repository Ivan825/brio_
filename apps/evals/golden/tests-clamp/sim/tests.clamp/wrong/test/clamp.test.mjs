import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/clamp.mjs";

test("inside", () => assert.equal(clamp(5, 0, 10), 5));
