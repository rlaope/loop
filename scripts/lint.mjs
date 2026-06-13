#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [".github", "bin", "scripts", "src", "test"];
const checkableExtensions = new Set([".js", ".mjs"]);
const textExtensions = new Set([".js", ".mjs", ".json", ".md", ".yml", ".yaml"]);

/**
 * @param {string} path
 * @returns {string[]}
 */
function walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
  }
  return [path];
}

/** @param {string} path */
function extensionOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

const files = roots.flatMap((root) => {
  try {
    return walk(root);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
});

for (const file of files) {
  const ext = extensionOf(file);
  if (checkableExtensions.has(ext)) {
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
  if (textExtensions.has(ext)) {
    const text = readFileSync(file, "utf8");
    const badLine = text.split("\n").findIndex((line) => /\s+$/.test(line));
    if (badLine !== -1) {
      throw new Error(`${file}:${badLine + 1} has trailing whitespace`);
    }
  }
}
