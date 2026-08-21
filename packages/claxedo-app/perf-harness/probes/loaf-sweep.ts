#!/usr/bin/env bun
// Sweep all 20 seeded measured switches, collecting per-switch LoAF summaries
// to correlate session weight with long-frame count/duration and phase offsets.
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { materializeClaxedoCorpus, readCanonicalCorpusDigest } from "../src/agent-corpus-materializer";
import { launchPackagedClaxedo } from "../src/agent-claxedo-launcher";
import { measureSessionActivation, warmSwitchPlan } from "../src/agent-browser-observer";

const TURNS = [12, 14, 17, 21, 25, 30, 36, 44, 53, 63, 76, 91, 110, 132, 159, 191, 230, 277, 333, 400];
const corpusPath = process.argv[2] ??
  "/Users/yashvardhansingh/test/opencode/.worktrees/perf-lcp/.artifacts/agent-app-benchmark/corpus-agent-app-graded-v1-6a020d15cf40.json";
const appPath = process.argv[3] ??
  "/Users/yashvardhansingh/test/opencode/.worktrees/perf-lcp/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app";

const digest = await readCanonicalCorpusDigest(corpusPath);
const scratch = await mkdtemp(path.join("/tmp", "claxedo-loaf-sweep-"));
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
        const host = window as unknown as { __loaf: Array<Record<string, unknown>> };
        host.__loaf = [];
        host.__loafObserver?.disconnect();
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const loaf = entry as PerformanceEntry & Record<string, unknown>;
            host.__loaf.push({
              duration: loaf.duration,
              blockingDuration: loaf.blockingDuration,
              styleAndLayoutStart: loaf.styleAndLayoutStart,
              renderStart: loaf.renderStart,
              scripts: ((loaf.scripts as Array<{ invoker?: string; duration: number }> ?? []) ?? []).map(
                (script) => `${Math.round(script.duration)}ms ${script.invoker ?? "?"}`,
              ),
            });
          }
        });
        observer.observe({ type: "long-animation-frame", buffered: false });
        host.__loafObserver = observer;
      });
    const collect = async () =>
      launch.page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const host = window as unknown as { __loafObserver?: PerformanceObserver; __loaf: Array<Record<string, unknown>> };
        for (const entry of host.__loafObserver?.takeRecords() ?? []) {
          const loaf = entry as PerformanceEntry & Record<string, unknown>;
          host.__loaf.push({
            duration: loaf.duration,
            blockingDuration: loaf.blockingDuration,
            styleAndLayoutStart: loaf.styleAndLayoutStart,
            renderStart: loaf.renderStart,
            scripts: [],
          });
        }
        return host.__loaf;
      });
    console.log("turns | switch-ms | LoAF n | longest | total-loaf-ms | script-attributed-ms");
    for (let index = 0; index < plan.measured.length; index++) {
      const target = plan.measured[index]!;
      const turns = TURNS[targets.indexOf(target)]!;
      await armObserver();
      const result = await measureSessionActivation(launch.page, target);
      if (result.state !== "exact") throw new Error(`switch ${turns}t failed: ${result.reason}`);
      const loaves = (await collect()) as Array<{
        duration: number;
        blockingDuration: number;
        scripts: string[];
      }>;
      const total = loaves.reduce((sum, loaf) => sum + loaf.duration, 0);
      const attributed = loaves.reduce((sum, loaf) => sum + loaf.scripts.reduce((a, b) => a + Number(b.split("ms")[0] ?? 0), 0), 0);
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
