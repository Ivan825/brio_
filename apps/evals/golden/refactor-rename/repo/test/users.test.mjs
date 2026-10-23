import assert from "node:assert/strict";
import { test } from "node:test";
import { getUser } from "../src/users.mjs";

test("finds", () => assert.equal(getUser(1).name, "Ada"));
