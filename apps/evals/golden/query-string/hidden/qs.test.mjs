import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "../src/qs.mjs";

test("arrays", () => assert.equal(stringify({ t: ["a", "b"] }), "t=a&t=b"));
test("undefined", () => assert.equal(stringify({ a: undefined, b: 2 }), "b=2"));
test("keys", () => assert.equal(stringify({ "a b": "&" }), "a%20b=%26"));
