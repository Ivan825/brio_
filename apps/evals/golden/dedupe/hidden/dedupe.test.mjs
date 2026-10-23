import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupe } from "../src/dedupe.mjs";

test("NaN", () => assert.deepEqual(dedupe([NaN, 1, NaN]), [NaN, 1]));
test("strings", () => assert.deepEqual(dedupe(["b", "a", "b"]), ["b", "a"]));
