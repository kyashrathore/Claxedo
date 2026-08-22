#!/usr/bin/env bun
// Show-and-tell driver: launch the packaged app against a fresh realistic-long
// fixture, open the heaviest session, settle the minimap/env card, capture a
// screenshot, and KEEP RUNNING so a human can poke at the same state.
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { materializeClaxedoCorpus, readCanonicalCorpusDigest } from "../src/agent-corpus-materializer";
import { launchPackagedClaxedo } from "../src/agent-claxedo-launcher";
import { measureSessionActivation } from "../src/agent-browser-observer";

const corpusPath = "/tmp/corpus-realistic-long.json";
const appPath =
  "/Users/yashvardhansingh/test/opencode/.worktrees/perf-beat-t3/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app";

const digest = await readCanonicalCorpusDigest(corpusPath);const scratch = await mkdtemp(path.join("/tmp", "claxedo-show-"));
const prepared = await materializeClaxedoCorpus({
  corpusPath,
  corpusDigestSha256: digest,
  dataDirectory: path.join(scratch, "data"),
  workspaceDirectory: path.join(scratch, "workspaces"),
  profiles: ["workspace-core-v1"],
});
const targets = prepared.readinessTargets;
const launch = await launchPackagedClaxedo({
  executable: path.join(appPath, "Contents/MacOS/Claxedo Dev"),
  isolatedProfilePath: path.join(scratch, "profile"),
  dataDirectory: path.join(scratch, "data"),
  readinessTargets: targets,
});
const heavy = targets[targets.length - 1]!;
const opened = await measureSessionActivation(launch.page, heavy);
console.log("heaviest opened:", opened.state === "exact" ? `${opened.durationMs.toFixed(0)}ms` : opened.reason);
await Bun.sleep(1200);
const shot = Bun.spawnSync(["screencapture", "-x", "/tmp/claxedo-show.png"]);
console.log("screenshot:", shot.exitCode === 0 ? "/tmp/claxedo-show.png" : `failed ${shot.exitCode}`);
// Hold the app open for human inspection; Ctrl-C this script to tear down.
await new Promise(() => {});
