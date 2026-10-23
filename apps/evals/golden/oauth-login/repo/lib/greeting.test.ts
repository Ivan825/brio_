import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "./greeting.ts";

test("greets by name", () => {
  assert.equal(greeting("Ada"), "Hello, Ada");
});
