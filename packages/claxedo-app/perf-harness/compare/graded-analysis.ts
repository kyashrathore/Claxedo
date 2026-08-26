#!/usr/bin/env bun
// Graded-corpus comparison analysis: per-session-weight warm-switch trend and
// app-vs-harness memory buckets for both apps.
//
//   bun compare/graded-analysis.ts \
//     --clx-workspace <dir with attempt.json + resource-ticks-*.ndjson> \
//     --clx-resource  <dir with attempt.json + resource-ticks-*.ndjson> \
//     --t3-workspace  <T3 attempt dir with result.json> \
//     --t3-resource   <T3 attempt dir with result.json + resources.ndjson>
//
// The switch plans are DETERMINISTIC; both repos' seeded orders are inlined
// below (importing the driver modules drags in node:sqlite / playwright
// graphs bun cannot load standalone). If either repo's plan function changes,
// these copies must change with it — the measured order printed per app is
// the cross-check: it must match the driver's own logs.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

// Turn counts of graded-v1 in corpus/session order (geometric 12 -> 400).
const TURNS = [12, 14, 17, 21, 25, 30, 36, 44, 53, 63, 76, 91, 110, 132, 159, 191, 230, 277, 333, 400];

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag} <path>`);
  return process.argv[index + 1]!;
}

// --- Claxedo plan (perf-harness/src/agent-browser-observer.ts) ---
function clxSeededSequence<T>(values: readonly T[], seed: number) {
  const result = [...values];
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}
function clxPlan<T extends { sessionId: string }>(values: readonly T[], seed: number) {
  const warmup = [...values];
  const measured = clxSeededSequence(values, seed);
  if (measured[0]?.sessionId === warmup.at(-1)?.sessionId) measured.push(measured.shift()!);
  return { warmup, measured };
}
const clxSeedNumber = (seed: string) => createHash("sha256").update(seed).digest().readUInt32LE(0);

// --- T3 plan (scripts/lib/agent-app-benchmark/drivers/t3.ts) ---
function t3SeededOrder(length: number, seed: string) {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  const order = Array.from({ length }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = state % (index + 1);
    [order[index], order[selected]] = [order[selected]!, order[index]!];
  }
  return order;
}
function t3Plan<T extends { sessionId: string }>(targets: readonly T[], seed: string) {
  const warmup = [...targets];
  const measured = t3SeededOrder(targets.length, seed).map((index) => targets[index]!);
  if (measured[0]?.sessionId === warmup.at(-1)?.sessionId) measured.push(measured.shift()!);
  return { warmup, measured };
}

const targets = TURNS.map((_, index) => ({ sessionId: `s${index.toString().padStart(2, "0")}` }));

function walk(node: unknown, visit: (value: Record<string, unknown>) => void) {
  if (Array.isArray(node)) for (const item of node) walk(item, visit);
  else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

function switchTrend(app: string, measuredIds: string[], durations: number[]) {
  const rows = measuredIds.map((sessionId, sequence) => ({
    turns: TURNS[Number(sessionId.slice(1))]!,
    ms: durations[sequence]!,
  }));
  rows.sort((a, b) => a.turns - b.turns);
  console.log(`\n${app} warm-switch by session size (turns -> ms):`);
  for (const row of rows) console.log(`  ${String(row.turns).padStart(3)} turns: ${row.ms.toFixed(1)} ms`);
  const bucket = (low: number, high: number) => rows.filter((row) => row.turns > low && row.turns <= high);
  const avg = (list: typeof rows) =>
    (list.reduce((total, row) => total + row.ms, 0) / Math.max(1, list.length)).toFixed(1);
  console.log(
    `  buckets: light(<=40t) avg ${avg(bucket(0, 40))} | mid(41-160t) avg ${avg(bucket(40, 160))} | heavy(>160t) avg ${avg(bucket(160, 1e9))}`,
  );
}

const memStats = (values: number[]) =>
  values.length
    ? `peak ${Math.max(...values).toFixed(0)} avg ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(0)}`
    : "(no ticks)";

// ---- Claxedo warm-switch trend
{
  const attempt = JSON.parse(readFileSync(`${argValue("--clx-workspace")}/attempt.json`, "utf8"));
  const durations: number[] = [];
  walk(attempt, (node) => {
    if (node.metric === "work_item.warm_switch_p95_ms" && Array.isArray(node.evidence)) {
      for (const entry of node.evidence as Array<Record<string, number | string>>) {
        if (entry.name === "trusted-session-switch-to-stable-paint")
          durations.push(Number(entry.endTimestamp) - Number(entry.startTimestamp));
      }
    }
  });
  const plan = clxPlan(targets, clxSeedNumber("1"));
  console.log("claxedo measured order:", plan.measured.map((target) => target.sessionId).join(","));
  if (durations.length >= 20) switchTrend("Claxedo", plan.measured.map((target) => target.sessionId), durations);
  else console.log("claxedo: warm-switch evidence incomplete:", durations.length);
}

// ---- T3 warm-switch trend
{
  const attempt = JSON.parse(readFileSync(`${argValue("--t3-workspace")}/result.json`, "utf8"));
  const bySequence = new Map<number, number>();
  walk(attempt, (node) => {
    if (node.metric === "work_item.warm_switch_p95_ms" && Array.isArray(node.evidence)) {
      const entries = node.evidence as Array<Record<string, number>>;
      if (entries.length >= 20 && bySequence.size === 0)
        for (const entry of entries)
          bySequence.set(Number(entry.sequence), Number(entry.endTimestamp) - Number(entry.startTimestamp));
    }
  });
  const plan = t3Plan(targets, "1");
  const durations = [...bySequence.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  console.log("\nt3 measured order:", plan.measured.map((target) => target.sessionId).join(","));
  if (durations.length >= 20) switchTrend("T3", plan.measured.map((target) => target.sessionId), durations);
  else console.log("t3: warm-switch evidence incomplete:", durations.length);
}

// ---- Claxedo memory buckets (per-tick app/harness split emitted by the runner)
for (const dir of [argValue("--clx-workspace"), argValue("--clx-resource")]) {
  for (const file of readdirSync(dir).filter((name) => name.startsWith("resource-ticks"))) {
    const rows = readFileSync(`${dir}/${file}`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (!rows.length) continue;
    const mib = (key: string) => rows.map((row) => Number(row[key] ?? 0) / 1048576);
    const cpu = rows.filter((row) => row.cpuPercent !== undefined).map((row) => Number(row.cpuPercent));
    console.log(`\nClaxedo ${file} (${rows.length} ticks) MiB:`);
    console.log(`  whole family:  ${memStats(mib("rssBytes"))}`);
    console.log(`  app-owned:     ${memStats(mib("appRssBytes"))}`);
    console.log(`  harness-owned: ${memStats(mib("harnessRssBytes"))}`);
    if (cpu.length) console.log(`  cpu %:         ${memStats(cpu)} (n=${cpu.length})`);
  }
}

// ---- T3 memory buckets + active/idle CPU from per-process snapshots
{
  const dir = argValue("--t3-resource");
  const result = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
  const windows: Record<string, Array<[number, number]>> = {};
  walk(result, (node) => {
    const metric = node.metric as string | undefined;
    if (
      (metric === "resource.peak_process_family_rss_mib" || metric === "resource.quiescent_cpu_p95_pct") &&
      Array.isArray(node.evidence)
    ) {
      for (const entry of node.evidence as Array<Record<string, number>>) {
        if (entry.startTimestamp !== undefined)
          (windows[metric] ??= []).push([Number(entry.startTimestamp), Number(entry.endTimestamp)]);
      }
    }
  });
  const ticks: Array<{ at: number; cpu: number; whole: number; app: number; harness: number }> = [];
  for (const line of readFileSync(`${dir}/resources.ndjson`, "utf8").trim().split("\n")) {
    const sample = JSON.parse(line)?.sample;
    const processes = sample?.snapshot?.processes as
      | Array<{ residentBytes: number; cpuPercent?: number; command: string }>
      | undefined;
    if (!processes?.length) continue;
    let app = 0;
    let harness = 0;
    let cpu = 0;
    for (const proc of processes) {
      cpu += proc.cpuPercent ?? 0;
      if (proc.command.includes("/.electron-runtime/")) app += proc.residentBytes;
      else harness += proc.residentBytes;
    }
    ticks.push({ at: sample.monotonicTimeMs, cpu, whole: (app + harness) / 1048576, app: app / 1048576, harness: harness / 1048576 });
  }
  const inWindows = (metric: string) =>
    ticks.filter((tick) => (windows[metric] ?? []).some(([start, end]) => tick.at >= start && tick.at <= end));
  const report = (label: string, subset: typeof ticks) => {
    console.log(`\nT3 ${label} (${subset.length} ticks) MiB:`);
    console.log(`  whole family:  ${memStats(subset.map((tick) => tick.whole))}`);
    console.log(`  app-owned:     ${memStats(subset.map((tick) => tick.app))}`);
    console.log(`  harness-owned: ${memStats(subset.map((tick) => tick.harness))}`);
    console.log(`  cpu %:         ${memStats(subset.map((tick) => tick.cpu))}`);
  };
  report("whole resource run", ticks);
  report("ACTIVE (sweep windows)", inWindows("resource.peak_process_family_rss_mib"));
  report("IDLE (quiescence windows)", inWindows("resource.quiescent_cpu_p95_pct"));
}
