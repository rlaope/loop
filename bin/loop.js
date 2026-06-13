#!/usr/bin/env node

import {
  appendEvidence,
  checkRepoBoundary,
  createRunState,
  evaluatePolicyGate,
  printHelp,
  recordBudgetActivity,
  writeRunState
} from "../src/index.js";

const args = process.argv.slice(2);

/** @param {string} flag */
function valueFor(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** @param {string} flag */
function has(flag) {
  return args.includes(flag);
}

if (has("--help") || has("-h")) {
  printHelp(process.stdout);
  process.exit(0);
}

let objective;
try {
  objective = valueFor("--objective");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
  printHelp(process.stderr);
  process.exit(1);
}

if (!objective) {
  printHelp(process.stderr);
  process.exit(1);
}

if (has("--dry-run")) {
  let stateDir;
  let expectedRoot;
  let expectedRemote;
  try {
    stateDir = valueFor("--state-dir") ?? ".loop";
    expectedRoot = valueFor("--expected-root");
    expectedRemote = valueFor("--expected-remote");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  if (expectedRoot || expectedRemote) {
    const boundary = checkRepoBoundary({
      expectedRoot,
      expectedRemote
    });
    if (!boundary.ok) {
      process.stderr.write(`Repo boundary preflight failed:\n${boundary.errors.join("\n")}\n`);
      process.exit(2);
    }
  }

  const initial = createRunState({ objective });
  const gate = evaluatePolicyGate(initial, {
    mode: "read",
    nextActivity: {
      estimatedTokens: 0,
      attempts: 1
    }
  });
  if (!gate.ok) {
    process.stderr.write(`Policy gate failed: ${gate.reason}\n`);
    process.exit(3);
  }

  const budgeted = recordBudgetActivity(initial, {
    kind: "adapter-smoke",
    estimatedTokens: 0,
    attempts: 1
  });
  const state = appendEvidence(budgeted, {
    kind: "dry-run",
    status: "passed",
    summary: "Dry-run recorded durable state without changing source files."
  });
  let paths;
  try {
    paths = await writeRunState(state, { stateDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`State write failed: ${message}\n`);
    process.exit(4);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, stateId: state.id, paths }, null, 2)}\n`);
  process.exit(0);
}

printHelp(process.stderr);
process.exit(1);
