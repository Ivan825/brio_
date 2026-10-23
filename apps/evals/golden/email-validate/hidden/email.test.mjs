import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmail } from "../src/email.mjs";

test("rejects", () => {
  assert.equal(isEmail("a@b"), false);
  assert.equal(isEmail("a b@x.io"), false);
  assert.equal(isEmail("@x.io"), false);
});
test("subdomains", () => assert.equal(isEmail("first.last@mail.example.co"), true));
