import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "../src/qs.mjs";

test("encodes", () => assert.equal(stringify({ a: 1, b: "x y" }), "a=1&b=x%20y"));
