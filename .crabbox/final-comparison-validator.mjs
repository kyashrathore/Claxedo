#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_COMPARISON_ROOT = "/Users/yashvardhansingh/test/agent-app-benchmark/artifacts/comparisons/solid2-web-vs-t3-v3-quick-20260823";
const DEFAULT_FRAMEWORK_ROOT = "/Users/yashvardhansingh/test/agent-app-benchmark/.worktrees/codex-web-target-comparison";
const COMPARISON_ID = "solid2-web-vs-t3-v3-quick-20260823";
const FRAMEWORK_REVISION = "d0d11bce442cb447db8efd6c15f7b1d686c37da2";
const SCHEDULE_DIGEST = "a591aac14716d8cb3d2d8f7cce6e85c2baac0034e9cd49eb410863c4d41b9018";
const CORPUS_DIGEST = "8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc";
const EVENT_SCHEMA_DIGEST = "f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac";
const MAPPING_DIGEST = "41f8087d59cea41172d8c5347ef36157a18139f637ff2556cd1f0bf5c536d66f";
const SIZE_BYTES = [1_048_576, 8_388_608, 33_554_432, 134_217_728];
const LANES = [
  "within-workspace-cold",
  "within-workspace-warm",
  "across-workspaces-cold",
  "across-workspaces-warm",
];
const APPS = {
  t3: {
    label: "T3",
    build: "74e646ac34fa3f9b71436a9536503c1d82b1fde864e3bd897b82ba47ff7bf9dd",
    driver: "d1bc5152edf680cd7eb76f23fb5376a78b30f6acfdd85d834f5ca3ea754421f8",
    source: "22c4e40aa8818956556cffbe381ca3efbbf74327",
    materialization: "translated",
  },
  "claxedo-web": {
    label: "Claxedo",
    build: "e5b527228b546a342a8eec8e9e90578178edddb95fcdfc2939fb829dce8f97f6",
    driver: "c94470f70735b88f25ad1b162afb07312f737b3fbe4d0ee964bd400a55b0c7c8",
    source: "d631aad47c16f4d33e1dc64c3dfd3c5abbe3014b",
    materialization: "native-opencode",
  },
};

const comparisonRoot = path.resolve(process.argv[2] ?? DEFAULT_COMPARISON_ROOT);
const frameworkRoot = path.resolve(process.argv[3] ?? DEFAULT_FRAMEWORK_ROOT);
const comparisonFile = path.join(comparisonRoot, "comparison.json");
const { loadComparison } = await import(pathToFileURL(path.join(frameworkRoot, "src/comparison.mjs")));
const loaded = await loadComparison(comparisonFile);

assert.equal(loaded.manifest.id, COMPARISON_ID);
assert.equal(loaded.manifest.schemaVersion, 1);
assert.equal(loaded.manifest.provenance, "community-self-attested");
assert.equal(loaded.manifest.results.length, 4);
assert.deepEqual(
  loaded.manifest.results.map(({ appId, scenarioId, path: resultPath }) => ({ appId, scenarioId, path: resultPath })),
  [
    { appId: "t3", scenarioId: "app-start-v3", path: "runs/t3/app-start-v3/result.json" },
    { appId: "claxedo-web", scenarioId: "app-start-v3", path: "runs/claxedo-web/app-start-v3/result.json" },
    { appId: "claxedo-web", scenarioId: "session-switch-v3", path: "runs/claxedo-web/session-switch-v3/result.json" },
    { appId: "t3", scenarioId: "session-switch-v3", path: "runs/t3/session-switch-v3/result.json" },
  ],
);
assert.deepEqual(loaded.compatibility, {
  "app-start-v3": { status: "valid", reason: undefined },
  "session-switch-v3": { status: "valid", reason: undefined },
});

const schedule = JSON.parse(await readFile(path.join(comparisonRoot, "schedule.json"), "utf8"));
assert.deepEqual(schedule, {
  version: 3,
  policy: "balanced-mirrored-v3",
  steps: [
    { ordinal: 1, appId: "t3", scenarioId: "app-start-v3" },
    { ordinal: 2, appId: "claxedo-web", scenarioId: "app-start-v3" },
    { ordinal: 3, appId: "claxedo-web", scenarioId: "session-switch-v3" },
    { ordinal: 4, appId: "t3", scenarioId: "session-switch-v3" },
  ],
  digestSha256: SCHEDULE_DIGEST,
});

const byIdentity = new Map();
for (const { result } of loaded.results) {
  const identity = `${result.app.id}:${result.scenario.id}`;
  assert(!byIdentity.has(identity), `duplicate result ${identity}`);
  byIdentity.set(identity, result);
  const expectedApp = APPS[result.app.id];
  assert(expectedApp, `unexpected app ${result.app.id}`);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.provenance.kind, "community-self-attested");
  assert.equal(result.provenance.comparisonRunId, COMPARISON_ID);
  assert.equal(result.provenance.frameworkRevision, FRAMEWORK_REVISION);
  assert.equal(result.provenance.comparisonScheduleDigestSha256, SCHEDULE_DIGEST);
  assert.equal(result.app.buildDigestSha256, expectedApp.build);
  assert.equal(result.driver.digestSha256, expectedApp.driver);
  assert.equal(result.driver.sourceCommit, expectedApp.source);
  assert.equal(result.materialization.mode, expectedApp.materialization);
  assert.equal(result.materialization.corpusDigestSha256, CORPUS_DIGEST);
  assert.equal(result.materialization.mappingDigestSha256, MAPPING_DIGEST);
  assert.equal(result.corpus.digestSha256, CORPUS_DIGEST);
  assert.equal(result.corpus.status, "public-comparable");
  assert.equal(result.sourceEventFormat.schemaDigestSha256, EVENT_SCHEMA_DIGEST);
  assert.equal(result.scenario.status, "public-comparable");
  assert.equal(result.runProfile, "quick");
  assert.equal(result.repetitions, 2);
  assert.equal(result.environment.platform, "linux");
  assert.equal(result.environment.architecture, "x64");
  assert.equal(result.environment.nodeVersion, "v24.15.0");
  assert.equal(result.environment.logicalCpuCount, 4);
  assert.equal(result.environment.totalMemoryBytes, 16_463_405_056);
  assert(result.observations.every((observation) => observation.status === "valid"), `${identity} contains an invalid observation`);
  for (const observation of result.observations) {
    assert(Number.isFinite(observation.durationMs) && observation.durationMs >= 0, `${observation.case.caseId} has an invalid duration`);
    assert.equal(observation.readiness.endpoint, "correct-content-painted-and-input-ready");
    assert(observation.readiness.checks.length > 0 && observation.readiness.checks.every((check) => check.passed), `${observation.case.caseId} failed readiness`);
  }
}

for (const appId of Object.keys(APPS)) {
  validateAppStart(get(appId, "app-start-v3"));
  validateSessionSwitch(get(appId, "session-switch-v3"));
}

function get(appId, scenarioId) {
  const result = byIdentity.get(`${appId}:${scenarioId}`);
  assert(result, `missing ${appId}:${scenarioId}`);
  return result;
}

function validateAppStart(result) {
  assert.equal(result.observations.length, 4);
  assert.equal(result.resources, null);
  assert.equal(result.resourceTrace, null);
  for (const mode of ["new-application-state", "initialized-application-state"]) {
    const observations = result.observations.filter((item) => item.case.startMode === mode);
    assert.equal(observations.length, 2, `${result.app.id}:${mode} count`);
    assert.deepEqual(observations.map((item) => item.case.repetition).sort(), [0, 1]);
    const summary = result.derivation.summary[mode];
    assert.equal(summary.status, "valid");
    assert.equal(summary.valid, 2);
    assert.equal(summary.attempted, 2);
    assert.equal(summary.p95, null);
    assert.equal(summary.p95Status, "requires-20-valid-observations");
  }
}

function validateSessionSwitch(result) {
  assert.equal(result.observations.length, 106);
  const expectedWorkloads = {
    "isolated-latency": 80,
    "transcript-size-latency": 16,
    "progressive-resource": 8,
    "resource-control": 2,
  };
  for (const [workload, count] of Object.entries(expectedWorkloads)) {
    assert.equal(result.observations.filter((item) => item.case.workload === workload).length, count, `${result.app.id}:${workload} count`);
  }
  for (const lane of LANES) {
    const [workspaceRelation, sessionState] = lane.match(/^(within-workspace|across-workspaces)-(cold|warm)$/).slice(1);
    const observations = result.observations.filter((item) => item.case.workload === "isolated-latency"
      && item.case.workspaceRelation === workspaceRelation && item.case.sessionState === sessionState);
    assert.equal(observations.length, 20, `${result.app.id}:${lane} count`);
    assert.deepEqual(unique(observations.map((item) => item.case.repetition)), [0, 1]);
    assert.deepEqual(unique(observations.map((item) => item.case.sample)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const summary = result.derivation.summary[lane];
    assert.equal(summary.status, "valid");
    assert.equal(summary.valid, 20);
    assert.equal(summary.attempted, 20);
    assert(Number.isFinite(summary.average) && Number.isFinite(summary.maximum) && Number.isFinite(summary.p95));
  }
  const sizeObservations = result.observations.filter((item) => item.case.workload === "transcript-size-latency");
  assert.deepEqual(unique(sizeObservations.map((item) => item.case.transcriptBytes)), SIZE_BYTES);
  for (const bytes of SIZE_BYTES) {
    const observations = sizeObservations.filter((item) => item.case.transcriptBytes === bytes);
    assert.equal(observations.length, 4, `${result.app.id}:size:${bytes} count`);
    assert.deepEqual(unique(observations.map((item) => item.case.repetition)), [0, 1]);
    assert.deepEqual(unique(observations.map((item) => item.case.sample)), [0, 1]);
    const summary = result.derivation.summary.transcriptSizeTrend.find((item) => item.transcriptBytes === bytes);
    assert(summary, `missing ${result.app.id}:size:${bytes} summary`);
    assert.equal(summary.status, "valid");
    assert.equal(summary.valid, 4);
    assert.equal(summary.attempted, 4);
    assert.equal(summary.p95, null);
    assert.equal(summary.p95Status, "requires-20-valid-observations");
  }
  const progressive = result.observations.filter((item) => item.case.workload === "progressive-resource");
  assert.deepEqual(unique(progressive.map((item) => item.case.transcriptBytes)), SIZE_BYTES);
  for (const bytes of SIZE_BYTES) {
    const observations = progressive.filter((item) => item.case.transcriptBytes === bytes);
    assert.equal(observations.length, 2, `${result.app.id}:progressive:${bytes} count`);
    assert.deepEqual(unique(observations.map((item) => item.case.repetition)), [0, 1]);
  }
  const controls = result.observations.filter((item) => item.case.workload === "resource-control");
  assert.equal(controls.length, 2);
  assert.deepEqual(unique(controls.map((item) => item.case.repetition)), [0, 1]);
  assert.equal(result.resources.status, "valid");
  assert.equal(result.resources.trend.length, 8);
  assert.deepEqual(unique(result.resources.trend.map((item) => item.transcriptBytes)), SIZE_BYTES);
  assert.deepEqual(unique(result.resources.trend.map((item) => item.repetition)), [0, 1]);
  assert.equal(result.resourceTrace.version, 2);
  assert.equal(result.resourceTrace.runs.length, 2);
  assert.deepEqual(result.resourceTrace.runs.map((run) => run.repetition), [0, 1]);
  for (const run of result.resourceTrace.runs) {
    assert.equal(run.failure, null);
    assert.deepEqual(run.monitorErrors, []);
    assert.equal(run.boundaries.length, 4);
  }
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

const t3Start = get("t3", "app-start-v3");
const claxStart = get("claxedo-web", "app-start-v3");
const t3Switch = get("t3", "session-switch-v3");
const claxSwitch = get("claxedo-web", "session-switch-v3");
const primary = [];
const secondary = [];

for (const mode of ["new-application-state", "initialized-application-state"]) {
  primary.push(compare(`Startup average: ${mode}`, "ms", t3Start.derivation.summary[mode].average, claxStart.derivation.summary[mode].average));
  secondary.push(compare(`Startup maximum: ${mode}`, "ms", t3Start.derivation.summary[mode].maximum, claxStart.derivation.summary[mode].maximum));
}
for (const lane of LANES) {
  const t3 = t3Switch.derivation.summary[lane];
  const clax = claxSwitch.derivation.summary[lane];
  primary.push(compare(`Switch average: ${lane}`, "ms", t3.average, clax.average));
  secondary.push(compare(`Switch p95: ${lane}`, "ms", t3.p95, clax.p95));
  secondary.push(compare(`Switch maximum: ${lane}`, "ms", t3.maximum, clax.maximum));
}
for (const bytes of SIZE_BYTES) {
  const t3 = t3Switch.derivation.summary.transcriptSizeTrend.find((item) => item.transcriptBytes === bytes);
  const clax = claxSwitch.derivation.summary.transcriptSizeTrend.find((item) => item.transcriptBytes === bytes);
  primary.push(compare(`Transcript-size average: ${formatBytes(bytes)}`, "ms", t3.average, clax.average));
  secondary.push(compare(`Transcript-size maximum: ${formatBytes(bytes)}`, "ms", t3.maximum, clax.maximum));
}
for (const [field, label] of [
  ["baselineIdleAverageRssMiB", "RSS: baseline idle average"],
  ["activeAverageRssMiB", "RSS: active average"],
  ["activeMaximumRssMiB", "RSS: active maximum"],
  ["activeP95RssMiB", "RSS: active p95"],
  ["endingIdleAverageRssMiB", "RSS: ending idle average"],
  ["retainedRssGrowthMiB", "RSS: retained growth"],
]) primary.push(compare(label, "MiB", t3Switch.resources[field], claxSwitch.resources[field]));

for (const bytes of SIZE_BYTES) {
  const t3Points = t3Switch.resources.trend.filter((item) => item.transcriptBytes === bytes);
  const claxPoints = claxSwitch.resources.trend.filter((item) => item.transcriptBytes === bytes);
  primary.push(compare(`CPU average: ${formatBytes(bytes)}`, "% of one core", average(t3Points.map((item) => item.cpuPercent)), average(claxPoints.map((item) => item.cpuPercent))));
  secondary.push(compare(`Progressive RSS average: ${formatBytes(bytes)}`, "MiB", average(t3Points.map((item) => item.rssMiB)), average(claxPoints.map((item) => item.rssMiB))));
}

function average(values) {
  assert(values.length > 0 && values.every(Number.isFinite));
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compare(metric, unit, t3, claxedo) {
  assert(Number.isFinite(t3) && Number.isFinite(claxedo), `${metric} is not finite`);
  if (t3 === claxedo) return { metric, unit, t3, claxedo, winner: "Tie", absoluteMargin: 0, percentMargin: 0 };
  const winner = t3 < claxedo ? "T3" : "Claxedo";
  const loser = Math.max(t3, claxedo);
  const winning = Math.min(t3, claxedo);
  return {
    metric,
    unit,
    t3,
    claxedo,
    winner,
    absoluteMargin: loser - winning,
    percentMargin: loser > 0 ? 100 * (loser - winning) / loser : null,
  };
}

function formatBytes(bytes) {
  return `${bytes / 1_048_576} MiB`;
}

process.stdout.write(`${JSON.stringify({
  validation: {
    status: "valid",
    comparisonId: COMPARISON_ID,
    resultCount: loaded.results.length,
    observationCounts: Object.fromEntries([...byIdentity].map(([identity, result]) => [identity, result.observations.length])),
    compatibility: loaded.compatibility,
    marginFormula: "lower-is-better; absolute=loser-winner; percent=100*(loser-winner)/loser when loser>0, otherwise unavailable",
  },
  rows: { primary, secondary },
}, null, 2)}\n`);
