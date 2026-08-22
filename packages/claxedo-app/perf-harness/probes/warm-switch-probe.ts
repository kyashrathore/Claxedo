#!/usr/bin/env bun
// Warm-switch iteration probe for the graded-v1 corpus.
//
// Materializes the corpus into a throwaway fixture, launches the PACKAGED app,
// and runs the same seeded warm-up + measured pass as the benchmark's
// workspace scenario (same observer, same plan), printing per-switch
// stable-paint samples mapped to session weight. Optional --loaf aggregates
// Long Animation Frames script attributions per switch for hot-spot hunting.
//
// This exists because iteration via the full benchmark wrapper costs a
// packaged-app rebuild plus two gated arms per data point. The probe keeps the
// measurement identical (measureSessionActivation + warmSwitchPlan) while
// dropping manifests, resource arms, and budget gating.
//
// Usage:
//   bun probes/warm-switch-probe.ts [--app <App.app>] [--corpus <json>] \
//     [--seed 1] [--loaf] [--keep]
import path from "node:path";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  materializeClaxedoCorpus,
  readCanonicalCorpusDigest,
  type SessionReadinessTarget,
} from "../src/agent-corpus-materializer";
import { launchPackagedClaxedo } from "../src/agent-claxedo-launcher";
import { measureSessionActivation, warmSwitchPlan } from "../src/agent-browser-observer";

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function argFlag(flag: string) {
  return process.argv.includes(flag);
}

const harnessRoot = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(harnessRoot, "../../..");
const fallbackCorpus = path.join(
  repoRoot,
  ".artifacts/agent-app-benchmark/corpus-agent-app-graded-v1-6a020d15cf40.json",
);
const corpusPath = argValue("--corpus") ?? fallbackCorpus;
const appPath =
  argValue("--app") ??
  path.join(repoRoot, "packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app");
const seed = argValue("--seed") ?? "1";
const wantLoaf = argFlag("--loaf");
const passes = Number(argValue("--passes") ?? 1);

const digest = await readCanonicalCorpusDigest(corpusPath);
// Turn counts come from the corpus itself so any corpus works (the graded
// table is just its own ramp); materialization emits targets in session order.
const corpusJson = JSON.parse(await Bun.file(corpusPath).text()) as {
  sessions: Array<{ order: number; turns: Array<unknown> }>;
};
const TURNS_BY_ORDER = corpusJson.sessions
  .toSorted((left, right) => left.order - right.order)
  .map((session) => session.turns.length);
const scratch = await mkdtemp(path.join("/tmp", "claxedo-warm-switch-probe-"));
const dataDirectory = path.join(scratch, "data");
const workspaceDirectory = path.join(scratch, "workspaces");
const isolatedProfilePath = path.join(scratch, "profile");

try {
  const prepared = await materializeClaxedoCorpus({
    corpusPath,
    corpusDigestSha256: digest,
    dataDirectory,
    workspaceDirectory,
    profiles: ["workspace-core-v1"],
  });
  const targets: SessionReadinessTarget[] = prepared.readinessTargets;
  console.log(`fixture ${scratch}`);
  console.log(`corpus ${digest.slice(0, 12)} sessions ${targets.length}`);

  const launch = await launchPackagedClaxedo({
    executable: path.join(appPath, "Contents/MacOS/Claxedo Dev"),
    isolatedProfilePath,
    dataDirectory,
    readinessTargets: targets,
  });
  try {
    const plan = warmSwitchPlan(targets, Number(new Uint32Array(createHash("sha256").update(seed).digest().buffer)[0]));
    for (const target of plan.warmup) {
      const warmed = await measureSessionActivation(launch.page, target);
      if (warmed.state !== "exact") throw new Error(`warmup failed: ${"reason" in warmed ? warmed.reason : "?"}`);
    }
    console.log(`warmup complete (20 activations); passes ${passes}`);
    const rows: Array<{ pass: number; turns: number; ms: number }> = [];
    const loafByTurn = new Map<number, Array<{ duration: number; source: string }>>();
    for (let pass = 0; pass < passes; pass++) {
      for (let index = 0; index < plan.measured.length; index++) {
        const target = plan.measured[index]!;
        const turns = TURNS_BY_ORDER[targets.indexOf(target)] ?? -1;
        if (wantLoaf) {
          await launch.page.evaluate(() => {
            const host = window as unknown as {
              __loafObserver?: PerformanceObserver;
              __loaf: Array<PerformanceEntry & { scripts?: Array<{ name?: string; duration: number; invoker?: string }> }>;
            };
            host.__loaf = [];
            host.__loafObserver?.disconnect();
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) host.__loaf.push(entry);
            });
            observer.observe({ type: "long-animation-frame", buffered: false });
            host.__loafObserver = observer;
          });
        }
        const result = await measureSessionActivation(launch.page, target);
        if (result.state !== "exact") throw new Error(`switch pass ${pass} #${index} failed: ${result.reason}`);
        rows.push({ pass, turns, ms: result.durationMs });
        if (wantLoaf) {
          const entries = await launch.page.evaluate(async () => {
            // LoAF entries are delivered on the frame after the long task; give
            // the queue a beat, then drain whatever the observer holds.
            await new Promise((resolve) => setTimeout(resolve, 120));
            const host = window as unknown as {
              __loafObserver?: PerformanceObserver;
              __loaf: Array<PerformanceEntry & { scripts?: Array<{ name?: string; duration: number; invoker?: string }> }>;
            };
            for (const entry of host.__loafObserver?.takeRecords() ?? []) {
              host.__loaf.push(entry as PerformanceEntry & { scripts?: Array<{ name?: string; duration: number; invoker?: string }> });
            }
            return host.__loaf.map((entry) => ({
              duration: entry.duration,
              source: entry.scripts
                ?.map((script) => script.invoker ?? script.name ?? "?")
                .filter(Boolean)
                .join("|")
                .slice(0, 160),
            }));
          });
          loafByTurn.set(turns, entries.flatMap((item) => (item.source ? [{ duration: item.duration, source: item.source }] : [])));
        }
        console.log(`p${pass} ${String(turns).padStart(4)} turns  ${result.durationMs.toFixed(1)} ms`);
      }
    }
    const median = (ms: number[]) => {
      if (!ms.length) return NaN;
      const ordered = [...ms].sort((a, b) => a - b);
      return ordered[Math.floor(ordered.length / 2)]!;
    };
    const bucketMedian = (predicate: (turns: number) => boolean) =>
      median(rows.filter((row) => predicate(row.turns)).map((row) => row.ms)).toFixed(1);
    const perTurnPooled = rows.map((row) => row.ms);
    const orderedAll = [...perTurnPooled].sort((a, b) => a - b);
    const p95 = orderedAll[Math.min(orderedAll.length - 1, Math.ceil(orderedAll.length * 0.95) - 1)]!;
    console.log(
      `buckets light/mid/heavy MEDIAN over ${passes} passes: ${bucketMedian((t) => t <= 40)}/${bucketMedian((t) => t > 40 && t <= 160)}/${bucketMedian((t) => t > 160)}`,
    );
    console.log(`p95 pooled (${rows.length} switches): ${p95.toFixed(1)} ms`);
    if (wantLoaf) {
      const totals = new Map<string, { count: number; ms: number }>();
      for (const entries of loafByTurn.values()) {
        for (const entry of entries) {
          const key = entry.source.split("|")[0]!.slice(0, 80);
          const hit = totals.get(key) ?? { count: 0, ms: 0 };
          hit.count += 1;
          hit.ms += entry.duration;
          totals.set(key, hit);
        }
      }
      console.log("\nlong-animation-frame sources by total blocking ms:");
      for (const [source, hit] of [...totals].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15)) {
        console.log(`  ${hit.ms.toFixed(0).padStart(5)} ms  x${String(hit.count).padStart(3)}  ${source}`);
      }
    }
  } finally {
    await launch.shutdown();
  }
} finally {
  if (argFlag("--keep")) {
    console.log(`kept fixture: ${scratch}`);
  } else {
    await rm(scratch, { recursive: true, force: true });
  }
}
void cp;
