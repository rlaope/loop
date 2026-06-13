import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { packageName } from "../src/index.js";

test("exports package identity", () => {
  assert.equal(packageName, "@rlaope/loop");
});

test("package metadata exposes the public import entrypoint", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(packageJson.main, "./src/index.js");
  assert.equal(packageJson.exports["."], "./src/index.js");
  assert.equal(packageJson.exports["./package.json"], "./package.json");
  assert.equal(packageJson.publishConfig.access, "public");
});
