import assert from "node:assert/strict";
import { test } from "node:test";
import { getUser, getUsr } from "../src/users.mjs";

test("alias", () => assert.equal(getUsr, getUser));
test("missing", () => assert.equal(getUser(9), null));
