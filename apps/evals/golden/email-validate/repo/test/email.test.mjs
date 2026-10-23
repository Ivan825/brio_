import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmail } from "../src/email.mjs";

test("plus tag", () => assert.equal(isEmail("a+b@example.io"), true));
