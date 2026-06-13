import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("README links the core documentation set", async () => {
  const readme = await readFile("README.md", "utf8");

  for (const link of [
    "docs/loop-engineering.md",
    "docs/compatibility.md",
    "docs/safety.md",
    "docs/issues.md",
    "docs/roadmap.md",
    "examples/dry-run-maintenance.md"
  ]) {
    assert.match(readme, new RegExp(link.replace("/", "\\/")));
  }
});

test("compatibility docs label Claude adapter as roadmap", async () => {
  const compatibility = await readFile("docs/compatibility.md", "utf8");

  assert.ok(compatibility.includes("Codex `$loop`"));
  assert.ok(compatibility.includes("Claude Code namespaced `/loop`"));
  assert.match(compatibility, /Roadmap/);
});

test("safety docs include approval and budget boundaries", async () => {
  const safety = await readFile("docs/safety.md", "utf8");

  assert.match(safety, /humanApproval/);
  assert.match(safety, /Sub-agents|sub-agents/);
  assert.match(safety, /unexpected\s+parent\s+git\s+root/);
});

test("open-source docs avoid local machine paths", async () => {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "docs/repo-boundary.md",
    "docs/roadmap.md"
  ];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /\/Users\/|Desktop\/khope/);
  }
});
