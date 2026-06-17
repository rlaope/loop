import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createRunState,
  detectObsidianVaults,
  initObsidianSync,
  installObsidianSyncService,
  obsidianSyncConfigPath,
  obsidianSyncManifestPath,
  obsidianSyncStatus,
	  readObsidianSyncManifest,
	  readWikiIndex,
	  readWikiNote,
	  renderMacLaunchAgentPlist,
	  startObsidianSyncWatcher,
	  syncObsidianWiki,
	  writeWikiForRunState,
	  writeWikiSupportingNote
	} from "../src/index.js";

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "loop-obsidian-project-"));
  const project = join(root, "same-name-project");
  const stateDir = join(project, ".loop");
  const vault = join(root, "Knowledge Vault");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { root, project, stateDir, vault };
}

test("Obsidian status is read-only and detects candidate vaults", async () => {
  const { stateDir, vault, root } = await createProject();
  const status = await obsidianSyncStatus({
    stateDir,
    homeDir: root,
    searchRoots: [root],
    maxDepth: 2
  });
  const candidates = await detectObsidianVaults({
    searchRoots: [root],
    maxDepth: 2
  });

  assert.equal(status.configured, false);
  assert.equal(existsSync(obsidianSyncConfigPath(stateDir)), false);
  assert.equal(existsSync(obsidianSyncManifestPath(stateDir)), false);
  assert.ok(status.candidates.includes(vault));
  assert.ok(candidates.includes(vault));
});

test("Obsidian sync mirrors Loop Wiki user markdown into a collision-safe vault folder", async () => {
  const { project, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Build Obsidian sync",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  const wiki = await writeWikiForRunState(state, { stateDir });

  const init = await initObsidianSync({
    stateDir,
    cwd: project,
    vaultPath: vault,
    now: new Date("2026-06-16T06:01:00.000Z")
  });
  const result = await syncObsidianWiki({
    stateDir,
    now: new Date("2026-06-16T06:02:00.000Z")
  });
  const manifest = await readObsidianSyncManifest({ stateDir });
  const synced = manifest.notes[wiki.id];
  assert.ok(synced);
  const obsidianMarkdown = await readFile(join(vault, synced.obsidianRelativePath), "utf8");

  assert.equal(result.loopToObsidian, 1);
  assert.match(init.config.projectFolder, /^same-name-project-[a-f0-9]{12}$/);
  assert.match(synced.obsidianRelativePath, /^Loop\/same-name-project-[a-f0-9]{12}\//);
  assert.match(obsidianMarkdown, /# Build Obsidian sync/);
  assert.doesNotMatch(synced.obsidianRelativePath, /\/ai\//);
});

test("Obsidian sync derives sync root instead of trusting persisted config paths", async () => {
  const { project, root, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Ignore tampered Obsidian sync root",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  await writeWikiForRunState(state, { stateDir });
  const init = await initObsidianSync({ stateDir, cwd: project, vaultPath: vault });
  const outsideSyncRoot = join(root, "outside-sync-root");
  const config = JSON.parse(await readFile(obsidianSyncConfigPath(stateDir), "utf8"));
  await writeFile(obsidianSyncConfigPath(stateDir), `${JSON.stringify({
    ...config,
    syncRoot: outsideSyncRoot
  }, null, 2)}\n`);

  const status = await obsidianSyncStatus({ stateDir });
  const result = await syncObsidianWiki({ stateDir });

  assert.equal(status.config?.syncRoot, init.config.syncRoot);
  assert.equal(result.config.syncRoot, init.config.syncRoot);
  assert.equal(existsSync(outsideSyncRoot), false);

  const otherProjectFolder = "other-project-123456789abc";
  await writeFile(obsidianSyncConfigPath(stateDir), `${JSON.stringify({
    ...config,
    projectFolder: otherProjectFolder,
    syncRoot: join(vault, "Loop", otherProjectFolder)
  }, null, 2)}\n`);
  await assert.rejects(
    syncObsidianWiki({ stateDir }),
    /project identity does not match/
  );
  assert.equal(existsSync(join(vault, "Loop", otherProjectFolder)), false);
});

test("Obsidian edits import back into Loop Wiki markdown and refresh derived artifacts", async () => {
  const { project, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Import Obsidian edit",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  const wiki = await writeWikiForRunState(state, { stateDir });
  await initObsidianSync({ stateDir, cwd: project, vaultPath: vault });
  await syncObsidianWiki({ stateDir });
  const firstManifest = await readObsidianSyncManifest({ stateDir });
  const synced = firstManifest.notes[wiki.id];
  assert.ok(synced);
  const obsidianPath = join(vault, synced.obsidianRelativePath);
  await writeFile(obsidianPath, "# Imported from Obsidian\n\nA user edited this in Obsidian.\n");

  const result = await syncObsidianWiki({
    stateDir,
    now: new Date("2026-06-16T06:03:00.000Z")
  });
  const note = await readWikiNote(wiki.id, { stateDir });
  const memory = JSON.parse(await readFile(wiki.memoryPath, "utf8"));
  const index = await readWikiIndex({ stateDir });

  assert.equal(result.obsidianToLoop, 1);
  assert.match(note.markdown, /A user edited this in Obsidian/);
  assert.equal(memory.summary, "A user edited this in Obsidian.");
  assert.equal(index.notes.find((entry) => entry.id === wiki.id)?.summary, "A user edited this in Obsidian.");
});

test("Obsidian edits refresh supporting note AI memory body", async () => {
  const { project, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Import supporting Obsidian edit",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  await writeWikiForRunState(state, { stateDir });
  const supporting = await writeWikiSupportingNote({
    stateDir,
    runId: state.id,
    kind: "plan",
    title: "Obsidian plan note",
    body: "Original supporting body.",
    now: new Date("2026-06-16T06:01:00.000Z")
  });
  await initObsidianSync({ stateDir, cwd: project, vaultPath: vault });
  await syncObsidianWiki({ stateDir });
  const firstManifest = await readObsidianSyncManifest({ stateDir });
  const synced = firstManifest.notes[supporting.id];
  assert.ok(synced);
  await writeFile(join(vault, synced.obsidianRelativePath), [
    "# Edited supporting note",
    "",
    "> Loop Wiki plan note",
    "",
    "## Context",
    "",
    "- Type: plan",
    "",
    "## Note",
    "",
    "Updated supporting body from Obsidian.",
    "",
    "## How It Connects",
    "",
    "Connection text.",
    ""
  ].join("\n"));

  const result = await syncObsidianWiki({
    stateDir,
    now: new Date("2026-06-16T06:03:00.000Z")
  });
  const memory = JSON.parse(await readFile(supporting.memoryPath, "utf8"));
  const note = await readWikiNote(supporting.id, { stateDir });

  assert.equal(result.obsidianToLoop, 1);
  assert.match(note.markdown, /Updated supporting body from Obsidian/);
  assert.equal(memory.body, "Updated supporting body from Obsidian.");
  assert.equal(memory.summary, "Updated supporting body from Obsidian.");
});

test("Obsidian sync restores missing mirror files instead of propagating deletes", async () => {
  const { project, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Restore deleted Obsidian mirror",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  const wiki = await writeWikiForRunState(state, { stateDir });
  await initObsidianSync({ stateDir, cwd: project, vaultPath: vault });
  await syncObsidianWiki({ stateDir });
  const manifest = await readObsidianSyncManifest({ stateDir });
  const synced = manifest.notes[wiki.id];
  assert.ok(synced);
  const obsidianPath = join(vault, synced.obsidianRelativePath);
  await rm(obsidianPath);

  const result = await syncObsidianWiki({ stateDir });

  assert.equal(result.loopToObsidian, 1);
  assert.match(await readFile(obsidianPath, "utf8"), /# Restore deleted Obsidian mirror/);
  assert.match(await readFile(wiki.notePath, "utf8"), /# Restore deleted Obsidian mirror/);
});

test("Obsidian sync writes a conflict file and pauses a note when both sides changed", async () => {
  const { project, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Conflict Obsidian edit",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  const wiki = await writeWikiForRunState(state, { stateDir });
  await initObsidianSync({ stateDir, cwd: project, vaultPath: vault });
  await syncObsidianWiki({ stateDir });
  const firstManifest = await readObsidianSyncManifest({ stateDir });
  const synced = firstManifest.notes[wiki.id];
  assert.ok(synced);
  const obsidianPath = join(vault, synced.obsidianRelativePath);
  await writeFile(wiki.notePath, "# Loop side\n\nLoop-only change.\n");
  await writeFile(obsidianPath, "# Obsidian side\n\nObsidian-only change.\n");

  const result = await syncObsidianWiki({
    stateDir,
    now: new Date("2026-06-16T06:04:00.000Z")
  });
  const secondManifest = await readObsidianSyncManifest({ stateDir });
  const paused = secondManifest.notes[wiki.id];
  assert.ok(paused);
  assert.equal(result.conflicts, 1);
  assert.equal(paused.paused, true);
  assert.ok(paused.conflictPath);
  assert.match(await readFile(paused.conflictPath ?? "", "utf8"), /Loop detected edits on both sides/);
  assert.match(await readFile(wiki.notePath, "utf8"), /Loop-only change/);
  assert.match(await readFile(obsidianPath, "utf8"), /Obsidian-only change/);
});

test("Obsidian sync rejects corrupt manifest notes and paths outside the project mirror", async () => {
  const { project, stateDir, vault } = await createProject();
  const state = createRunState({
    objective: "Reject unsafe Obsidian manifest",
    now: new Date("2026-06-16T06:00:00.000Z")
  });
  const wiki = await writeWikiForRunState(state, { stateDir });
  await initObsidianSync({ stateDir, cwd: project, vaultPath: vault });
  await syncObsidianWiki({ stateDir });

  const manifest = await readObsidianSyncManifest({ stateDir });
  const synced = manifest.notes[wiki.id];
  assert.ok(synced);
  await writeFile(obsidianSyncManifestPath(stateDir), `${JSON.stringify({
    ...manifest,
    notes: {
      [wiki.id]: {
        ...synced,
        obsidianRelativePath: "Loop/another-project/note.md"
      }
    }
  }, null, 2)}\n`);
  await assert.rejects(
    syncObsidianWiki({ stateDir }),
    /Path escapes Obsidian sync boundary/
  );

  await writeFile(obsidianSyncManifestPath(stateDir), `${JSON.stringify({
    version: 1,
    updatedAt: "2026-06-16T06:05:00.000Z",
    notes: {
      [wiki.id]: { id: wiki.id }
    }
  }, null, 2)}\n`);
  await assert.rejects(
    readObsidianSyncManifest({ stateDir }),
    /manifest note .* must be a version 1 object/
  );
});

test("Obsidian sync watcher is single-flight", async () => {
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const watcher = startObsidianSyncWatcher({
    stateDir: ".loop",
    intervalMs: 1,
    syncImpl: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return { ok: true };
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 75));
  watcher.stop();

  assert.ok(calls >= 2);
  assert.equal(maxConcurrent, 1);
  assert.equal(watcher.stats().maxConcurrent, 1);
});

test("Obsidian sync service helper renders macOS plist and rejects unsupported platforms", async () => {
  const { stateDir, vault, root } = await createProject();
  await initObsidianSync({ stateDir, vaultPath: vault });
  const plist = renderMacLaunchAgentPlist({
    stateDir,
    label: "com.example.loop.obsidian-test",
    nodePath: "/usr/local/bin/node",
    scriptPath: "/usr/local/bin/loop",
    intervalMs: 1234
  });
  const escapedPlist = renderMacLaunchAgentPlist({
    stateDir: "state&dir",
    label: "com.example.<loop>",
    nodePath: "/usr/local/bin/node&tool",
    scriptPath: "/usr/local/bin/loop<cli>",
    intervalMs: 1234
  });
  const unsupported = await installObsidianSyncService({
    stateDir,
    homeDir: root,
    platformName: "linux"
  });

  assert.match(plist, /com\.example\.loop\.obsidian-test/);
  assert.match(plist, /obsidian/);
  assert.match(plist, /1234/);
  assert.match(escapedPlist, /com\.example\.&lt;loop&gt;/);
  assert.match(escapedPlist, /state&amp;dir/);
  assert.match(escapedPlist, /node&amp;tool/);
  assert.match(escapedPlist, /loop&lt;cli&gt;/);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.unsupported, true);
});
