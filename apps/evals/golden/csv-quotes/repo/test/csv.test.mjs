import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine } from "../src/csv.mjs";

test("quoted comma", () => assert.deepEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]));
