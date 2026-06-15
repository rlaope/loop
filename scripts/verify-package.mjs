#!/usr/bin/env node

const requiredFiles = [
  "README.md",
  "LICENSE",
  "bin/loop.js",
  "src/index.js",
  "skills/loop/SKILL.md",
  ".codex-plugin/plugin.json",
  "assets/loop-engineering-poster.png",
  "assets/loop-engineering-components.png"
];

/**
 * @param {string} message
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
}

let parsed;
try {
  parsed = JSON.parse(input);
} catch (error) {
  fail(`Could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
}

if (!Array.isArray(parsed) || parsed.length === 0) {
  fail("npm pack output did not include a package entry.");
}

const pack = parsed[0];
if (!pack || typeof pack !== "object" || !Array.isArray(pack.files)) {
  fail("npm pack output did not include a files list.");
}

/**
 * @param {unknown} file
 */
function filePath(file) {
  if (!file || typeof file !== "object" || !("path" in file)) {
    fail("npm pack file entry did not include a path.");
  }
  const path = /** @type {{ path: unknown }} */ (file).path;
  if (typeof path !== "string") {
    fail("npm pack file entry did not include a path.");
  }
  return path;
}

const files = new Set(pack.files.map(filePath));
const missing = requiredFiles.filter((file) => !files.has(file));

if (missing.length > 0) {
  fail(`Missing package files: ${missing.join(", ")}`);
}

console.log(`Package content verified: ${requiredFiles.length} required files present.`);
