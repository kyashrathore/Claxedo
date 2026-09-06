#!/usr/bin/env bun
// Sweep all 20 seeded measured switches, collecting per-switch LoAF summaries
// to correlate session weight with long-frame count/duration and phase offsets.
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { materializeClaxedoCorpus, readCanonicalCorpusDigest } from "../src/agent-corpus-materializer";
import { launchPackagedClaxedo } from "../src/agent-claxedo-launcher";
import { measureSessionActivation, warmSwitchPlan } from "../src/agent-browser-observer";
import { readLoafSamples } from "../src/browser/page-globals-read";
import type { LoafSample } from "../src/browser/page-globals";

const TURNS =[12, 14, 17, 21, 25, 30, 36, 44, 53, 63, 76, 91, 110, 132, 159, 191, 230, 277, 333, 400];
const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const corpusPath = process.argv[2];
const appPath = process.argv[3] ??
  path.join(repositoryRoot, "packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app");

if (!corpusPath) {
  throw new Error(
    "usage: bun probes/loaf-sweep.ts /absolute/path/to/corpus.json [/absolute/path/to/Claxedo.app]",
  );
}
if (!existsSync(corpusPath)) throw new Error(`corpus does not exist: ${corpusPath}`);
if (!existsSync(appPath)) {
  throw new Error(`Claxedo app bundle does not exist: ${appPath}. Build the repo-owned default or pass it explicitly.`);
}

const digest = await readCanonicalCorpusDigest(corpusPath);
const scratch = await mkdtemp(path.join(tmpdir(), "claxedo-loaf-sweep-"));
try {
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
  try {
    const seedNumber = createHash("sha256").update("1").digest().readUInt32LE(0);
    const plan = warmSwitchPlan(targets, seedNumber);
    for (const target of plan.warmup) {
      const warmed = await measureSessionActivation(launch.page, target);
      if (warmed.state !== "exact") throw new Error(`warmup failed: ${warmed.reason}`);
    }
    const armObserver = () =>
      launch.page.evaluate(() => {
        const samples: LoafSample[] = [];
        window.__loaf = samples;
        window.__loafObserver?.disconnect();
        const observer = new PerformanceObserver((list) => {
          for (const loaf of list.getEntries()) {
            samples.push({
              startTime: loaf.startTime,
              duration: loaf.duration,
              blockingDuration: loaf.blockingDuration,
              styleAndLayoutStart: loaf.styleAndLayoutStart,
              renderStart: loaf.renderStart,
              scripts: (loaf.scripts ?? []).map((script) => ({
                duration: script.duration,
                invoker: script.invoker,
              })),
            });
          }
        });
        observer.observe({ type: "long-animation-frame", buffered: false });
        window.__loafObserver = observer;
      });
    const collect = async () =>
      launch.page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const samples = (window.__loaf ??= []);
        for (const loaf of window.__loafObserver?.takeRecords() ?? []) {
          samples.push({
            startTime: loaf.startTime,
            duration: loaf.duration,
            blockingDuration: loaf.blockingDuration,
            styleAndLayoutStart: loaf.styleAndLayoutStart,
            renderStart: loaf.renderStart,
            // Drained entries are counted but not attributed: `takeRecords`
            // returns entries the observer callback never projected.
            scripts: [],
          });
        }
        return samples;
      });
    console.log("turns | switch-ms | LoAF n | longest | total-loaf-ms | script-attributed-ms");
    for (let index = 0; index < plan.measured.length; index++) {
      const target = plan.measured[index];
      const turns = TURNS[targets.indexOf(target)];
      await armObserver();
      const result = await measureSessionActivation(launch.page, target);
      if (result.state !== "exact") throw new Error(`switch ${turns}t failed: ${result.reason}`);
      const loaves = readLoafSamples(await collect());
      const total = loaves.reduce((sum, loaf) => sum + loaf.duration, 0);
      const attributed = loaves.reduce(
        (sum, loaf) => sum + loaf.scripts.reduce((a, script) => a + Math.round(script.duration), 0),
        0,
      );
      const longest = loaves.reduce((max, loaf) => Math.max(max, loaf.duration), 0);
      console.log(
        `${String(turns).padStart(4)}t | ${result.durationMs.toFixed(1).padStart(8)} | ${String(loaves.length).padStart(4)} | ${Math.round(longest).toString().padStart(5)}ms | ${Math.round(total).toString().padStart(8)} | ${Math.round(attributed).toString().padStart(8)}`,
      );
    }
  } finally {
    await launch.shutdown();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
