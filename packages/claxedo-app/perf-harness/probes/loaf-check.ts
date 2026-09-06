#!/usr/bin/env bun
// One-off: capture clean Long Animation Frames for ONE cross-session heavy
// switch (proper seeded plan; observer armed after warmup; buffered entries
// discarded so every recorded frame belongs to the measured switch).
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

const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
const corpusPath = process.argv[2];
const appPath = process.argv[3] ??
  path.join(repositoryRoot, "packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app");

if (!corpusPath) {
  throw new Error(
    "usage: bun probes/loaf-check.ts /absolute/path/to/corpus.json [/absolute/path/to/Claxedo.app]",
  );
}
if (!existsSync(corpusPath)) throw new Error(`corpus does not exist: ${corpusPath}`);
if (!existsSync(appPath)) {
  throw new Error(`Claxedo app bundle does not exist: ${appPath}. Build the repo-owned default or pass it explicitly.`);
}

const digest = await readCanonicalCorpusDigest(corpusPath);
const scratch = await mkdtemp(path.join(tmpdir(), "claxedo-loaf-check-"));
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
    // First two MEASURED targets (real switches away from the current session).
    await launch.page.evaluate(() => {
      const samples: LoafSample[] = [];
      window.__loaf = samples;
      new PerformanceObserver((list) => {
        for (const loaf of list.getEntries()) {
          samples.push({
            duration: loaf.duration,
            blockingDuration: loaf.blockingDuration,
            styleAndLayoutStart: loaf.styleAndLayoutStart,
            renderStart: loaf.renderStart,
            startTime: loaf.startTime,
            scripts: (loaf.scripts ?? []).map((script) => ({
              duration: script.duration,
              invoker: script.invoker,
              name: script.name,
            })),
          });
        }
      }).observe({ type: "long-animation-frame", buffered: false });
    });
    for (const target of plan.measured.slice(0, 2)) {
      const result = await measureSessionActivation(launch.page, target);
      console.log(
        "switch:",
        result.state === "exact" ? `${result.durationMs.toFixed(1)} ms` : `invalid ${result.reason}`,
      );
    }
    const loaves = readLoafSamples(
      await launch.page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return window.__loaf ?? [];
      }),
    );
    console.log(`LoAF entries across the two measured switches: ${loaves.length}`);
    for (const loaf of loaves) {
      const start = loaf.startTime;
      const layoutOffset =
        loaf.styleAndLayoutStart !== undefined ? Math.round(loaf.styleAndLayoutStart - start) : "?";
      const renderOffset = loaf.renderStart !== undefined ? Math.round(loaf.renderStart - start) : "?";
      console.log(
        `  ${Math.round(loaf.duration)}ms (blocking ${Math.round(loaf.blockingDuration ?? 0)}ms, style/layout @${layoutOffset}ms, render @${renderOffset}ms)`,
      );
      for (const script of loaf.scripts.slice(0, 4)) {
        console.log(`      ${Math.round(script.duration)}ms ${script.invoker ?? script.name ?? "?"}`);
      }
    }
  } finally {
    await launch.shutdown();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
