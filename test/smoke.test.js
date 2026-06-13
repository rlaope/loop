import test from "node:test";
import assert from "node:assert/strict";

import { packageName } from "../src/index.js";

test("exports package identity", () => {
  assert.equal(packageName, "@rlaope/loop");
});
