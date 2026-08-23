#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClaxedoAgentDriver } from "./agent-claxedo-driver";
import { readCanonicalCorpusDigest } from "./agent-corpus-materializer";
import { agentAppViewport } from "./agent-display-contract";
import { AGENT_APP_PROFILES, type AgentAppProfile, type AgentAppScenario } from "./agent-driver-contract";
import { captureHostState, acquireKeepAwake, environmentDisclosure, validateHostTransition, type HostState, type KeepAwakeLease } from "./agent-host-preflight";
import { PRIMARY_AGENT_APP_METRICS, resourceMetrics, type PrimaryAgentAppMetric } from "./agent-metrics";
import { isT3Process, macMemoryHelperPath, processFamily, processLineage, readPhysFootprint, readProcessTable, toIdleRows, totalPhysFootprintBytes, withPhysFootprint, type ProcessSnapshot } from "./agent-process-family";
import { IdleProcessFamilyTracker } from "./idle-process-family";
import { loadPriorEvidence, checkExperimentProposal } from "./agent-prior-evidence";
import { driverClock, rawMetricSample, type RawMetricSample, type ValidityCheckEvidence } from "./agent-samples";
import { evaluateTarget, loadAgentBenchmarkTargets } from "./agent-benchmark-targets";
import { writeJson } from "./storage";

const PROFILE_SCENARIOS: Record<AgentAppProfile, AgentAppScenario[]> = {
  "workspace-core-v1": ["app-cold-ready-v1", "work-item-cold-open-v1", "work-item-warm-switch-v1"],
  "conversation-rich-v1": ["controlled-stream-v1"],
  "terminal-core-v1": ["terminal-input-v1", "terminal-output-v1"],
  "resource-core-v1": ["resource-sweep-v1", "resource-quiescence-v1"],
};
const SCENARIO_METRICS: Record<AgentAppScenario, PrimaryAgentAppMetric[]> = {
  "app-cold-ready-v1": ["app.cold_ready_ms"],
  "work-item-cold-open-v1": ["work_item.cold_open_ms"],
  "work-item-warm-switch-v1": ["work_item.warm_switch_p95_ms"],
  "controlled-stream-v1": ["stream.interaction_p95_ms", "stream.blocked_frame_ratio_pct"],
  "terminal-input-v1": ["terminal.input_to_paint_p95_ms"],
  "terminal-output-v1": ["terminal.output_mib_s"],
  "resource-sweep-v1": ["resource.peak_process_family_rss_mib"],
  "resource-quiescence-v1": ["resource.quiescent_cpu_p95_pct"],
};

type Options = {
  app: string; profiles: AgentAppProfile[]; runProfile: "iteration"; seed: string;
  targetsPath: string; output: string; corpus?: string;
  experiment?: { question: string; priorEvidenceId?: string; invalidatedBoundary?: string; newMetric?: string };
};
type InspectResult = { surface: { visibilityState: string; focused: boolean; hidden: boolean; viewport: { width: number; height: number } }; processes: ProcessSnapshot[] };
type ResourceObservation = { atMs: number; rssBytes: number; physFootprintBytes?: number; cpuPercent?: number; processes: ProcessSnapshot[] };

export function parseAgentBenchmarkOptions(argv: string[], cwd = process.cwd()): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--app", "--profiles", "--run-profile", "--seed", "--targets", "--output", "--corpus", "--experiment-question", "--prior-evidence-id", "--invalidated-boundary", "--new-metric"]);
  const unknown = [...values.keys()].find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown option: ${unknown}`);
  const required = (name: string) => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const profileValue = required("--profiles");
  const profiles = profileValue === "all" ? [...AGENT_APP_PROFILES] : profileValue.split(",") as AgentAppProfile[];
  if (!profiles.length || new Set(profiles).size !== profiles.length || profiles.some((profile) => !AGENT_APP_PROFILES.includes(profile))) throw new Error(`invalid --profiles: ${profileValue}`);
  const runProfile = required("--run-profile");
  if (runProfile !== "iteration") throw new Error("U1 supports only --run-profile iteration; publication belongs to U11");
  const seed = required("--seed");
  if (!/^\d+$/u.test(seed)) throw new Error("--seed must be an unsigned integer");
  const question = values.get("--experiment-question")?.trim();
  const experimentFields = ["--prior-evidence-id", "--invalidated-boundary", "--new-metric"].filter((key) => values.has(key));
  if (!question && experimentFields.length) throw new Error("experiment exception fields require --experiment-question");
  const repoRoot = path.resolve(import.meta.dir, "../../../..");
  const resolveProjectPath = (value: string) => path.isAbsolute(value)
    ? path.normalize(value)
    : /^(?:packages|artifacts|\.artifacts|docs)[/\\]/u.test(value)
      ? path.resolve(repoRoot, value)
      : path.resolve(cwd, value);
  return {
    app: resolveProjectPath(required("--app")), profiles, runProfile, seed,
    targetsPath: resolveProjectPath(required("--targets")), output: resolveProjectPath(required("--output")),
    ...(values.get("--corpus") ? { corpus: resolveProjectPath(values.get("--corpus")!) } : {}),
    ...(question ? { experiment: { question, ...(values.get("--prior-evidence-id") ? { priorEvidenceId: values.get("--prior-evidence-id")! } : {}), ...(values.get("--invalidated-boundary") ? { invalidatedBoundary: values.get("--invalidated-boundary")! } : {}), ...(values.get("--new-metric") ? { newMetric: values.get("--new-metric")! } : {}) } } : {}),
  };
}

export async function runAgentAppBenchmark(options: Options) {
  await prepareOutput(options.output);
  const startedAt = new Date().toISOString();
  const runId = `claxedo-${startedAt.replace(/[^0-9]/gu, "").slice(0, 14)}-${options.seed}`;
  const repoRoot = path.resolve(import.meta.dir, "../../../..");
  const evidencePath = path.join(import.meta.dir, "../evidence/prior-evidence.json");
  const samples: RawMetricSample[] = [];
  let hostBefore: HostState | undefined;
  let hostAfter: HostState | undefined;
  let lease: KeepAwakeLease | undefined;
  let runtime: Awaited<ReturnType<typeof createClaxedoAgentDriver>> | undefined;
  let rootPid: number | undefined;
  let shutdown: unknown;
  let failure: string | undefined;
  let correlation = 0;
  const ownershipSnapshots: Array<{ at: string; processes: ProcessSnapshot[] }> = [];
  const call = async <T>(method: "hello" | "prepare" | "launch" | "run-scenario" | "inspect" | "shutdown", params: Record<string, unknown>) => {
    if (!runtime) throw new Error("driver runtime is unavailable");
    const response = await runtime.handle(JSON.stringify({ protocolVersion: 1, kind: "request", correlationId: `${runId}-${++correlation}`, method, params }));
    if (!response.ok) throw new Error(`${method}: ${response.error.code}: ${response.error.message}`);
    return response.result as T;
  };

  let targets: Awaited<ReturnType<typeof loadAgentBenchmarkTargets>> | undefined;
  let provenance: Record<string, unknown> = { schemaVersion: 1, runId, startedAt, application: "Claxedo", profiles: options.profiles, runProfile: options.runProfile, seed: options.seed };
  try {
    targets = await loadAgentBenchmarkTargets(options.targetsPath);
    const prior = await loadPriorEvidence(evidencePath);
    const experimentDecision = options.experiment ? checkExperimentProposal(prior, options.experiment) : { decision: "control-checkpoint", rationale: "No causal experiment was proposed." };
    const executable = await resolveExecutable(options.app);
    if (isT3Path(executable)) throw new Error("T3 executable or path is forbidden during U1-U10");
    const memoryHelperPath = macMemoryHelperPath(executable);
    const corpus = options.corpus ?? path.resolve(repoRoot, targets.corpus.path);
    const [executableDigest, corpusFileDigest, corpusDigest, targetsDigest, priorDigest, driverDigest, lockDigest, source] = await Promise.all([
      sha256File(executable), sha256File(corpus), readCanonicalCorpusDigest(corpus), sha256File(options.targetsPath), sha256File(evidencePath), hashDriverClosure(), hashLocks(repoRoot), sourceProvenance(repoRoot),
    ]);
    if (corpusDigest !== targets.corpus.sha256) throw new Error(`canonical corpus digest mismatch: expected ${targets.corpus.sha256}, got ${corpusDigest}`);
    hostBefore = await captureHostState();
    lease = await acquireKeepAwake();
    lease.assertActive();
    provenance = {
      ...provenance,
      executable: { requestedPath: options.app, resolvedPath: executable, sha256: executableDigest },
      driver: { entry: path.join(import.meta.dir, "agent-claxedo-driver.ts"), closureSha256: driverDigest },
      source,
      dependencyLock: lockDigest,
      corpus: { path: corpus, sha256: corpusDigest, fileSha256: corpusFileDigest },
      targets: { path: options.targetsPath, sha256: targetsDigest },
      priorEvidence: { path: evidencePath, sha256: priorDigest, entryCount: prior.entries.length },
      environment: environmentDisclosure(), preflight: hostBefore,
      keepAwake: { pid: lease.pid, ownerPid: process.pid }, experimentDecision,
    };
    runtime = await createClaxedoAgentDriver({ executable, driverDigestSha256: driverDigest });
    await call("hello", { frameworkVersion: 1 });
    const runDirectory = path.join(options.output, "run");
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const prepared = await call<{ coverage: Array<{ passed: boolean; profile: string }> }>("prepare", { corpusPath: corpus, corpusDigestSha256: corpusDigest, runDirectory, profiles: options.profiles });
    if (!prepared.coverage.every((item) => item.passed)) throw new Error(`corpus materialization coverage failed: ${JSON.stringify(prepared.coverage)}`);
    const launched = await call<{ processes: Array<{ pid: number }> }>("launch", { isolatedProfilePath: path.join(runDirectory, "profile") });
    rootPid = launched.processes[0]?.pid;
    if (!rootPid) throw new Error("driver did not declare an application root process");

    for (const profile of options.profiles) {
      for (const scenario of PROFILE_SCENARIOS[profile]) {
        lease.assertActive();
        const before = await call<InspectResult>("inspect", {});
        assertSurface(before.surface);
        const beforeChecks = processChecks(await readProcessTable(), rootPid);
        if (beforeChecks.failures.length) throw new Error(beforeChecks.failures.join(","));
        ownershipSnapshots.push({ at: new Date().toISOString(), processes: await withFootprint(beforeChecks.family, memoryHelperPath) });
        const attemptId = `${runId}-${profile}-${scenario}`;
        const settleMs = scenario === "resource-quiescence-v1" ? 15_000 : 0;
        const foregroundFailures: string[] = [];
        let healthActive = false;
        const inspectForeground = async () => {
          if (healthActive) return;
          healthActive = true;
          try { assertSurface((await call<InspectResult>("inspect", {})).surface); }
          catch (error) { foregroundFailures.push(`foreground-monitor:${error instanceof Error ? error.message : String(error)}`); }
          finally { healthActive = false; }
        };
        const healthTimer = setInterval(() => void inspectForeground(), 1_000);
        const measured = await runWithProcessSampling(rootPid, settleMs, memoryHelperPath, async () => await call<{ samples: RawMetricSample[] }>("run-scenario", { attemptId, profile, scenario, seed: options.seed })).finally(() => clearInterval(healthTimer));
        // Raw family ticks, persisted. The derived peak/p95 land in the sample
        // records, but the tick series itself was consumed in-process and
        // discarded — which made the cross-app resource matrix (peak/avg/p95
        // CPU+RSS over active vs idle windows) computable from the T3 arm's
        // artifacts and not from this one. One line per tick, family-summed,
        // same semantics as the T3 monitor's family series.
        await appendFile(
          path.join(options.output, `resource-ticks-${scenario}.ndjson`),
          measured.observations.map((item) => {
            // App-owned vs harness-owned split: a family process whose command
            // runs from inside the app bundle (its `.app/` prefix, derived
            // from the root process) is the application; anything else the app
            // spawned (git, agent harness binaries, shells) is harness-owned.
            // Whole-family totals stay the canonical metric; the buckets ride
            // along per tick so the cross-app table can report both.
            const root = item.processes.find((proc) => proc.pid === rootPid) ?? item.processes[0];
            const bundleEnd = root ? root.command.indexOf(".app/") : -1;
            const appPrefix = root && bundleEnd >= 0 ? root.command.slice(0, bundleEnd + 5) : undefined;
            let appRssBytes = 0;
            let harnessRssBytes = 0;
            for (const proc of item.processes) {
              if (!appPrefix || proc.command.startsWith(appPrefix)) appRssBytes += proc.rssBytes;
              else harnessRssBytes += proc.rssBytes;
            }
            return JSON.stringify({ scenario, atMs: item.atMs, rssBytes: item.rssBytes, appRssBytes, harnessRssBytes, ...(item.cpuPercent === undefined ? {} : { cpuPercent: item.cpuPercent }) });
          }).join("\n") + "\n",
        );
        await inspectForeground();
        measured.failures.push(...foregroundFailures);
        const after = await call<InspectResult>("inspect", {});
        const validity: ValidityCheckEvidence[] = [
          surfaceEvidence("surface-visible-before", before.surface), surfaceEvidence("surface-visible-after", after.surface),
          { check: "complete-process-ownership", expectedCount: 0, actualCount: measured.failures.length, passed: measured.failures.length === 0 },
          { check: "keep-awake-active", expectedCount: 1, actualCount: 1, passed: true },
        ];
        ownershipSnapshots.push({ at: new Date().toISOString(), processes: await withFootprint(after.processes, memoryHelperPath) });
        for (const raw of measured.value.samples) {
          let next = raw;
          if (raw.metric === "resource.peak_process_family_rss_mib" || raw.metric === "resource.quiescent_cpu_p95_pct") {
            const expectedDurationMs = Math.max(0, measured.endedAtMs - measured.startedAtMs - settleMs);
            const retained = raw.metric === "resource.peak_process_family_rss_mib"
              ? measured.observations.map((item) => ({ ...item, cpuPercent: item.cpuPercent ?? 0 }))
              : measured.observations.filter((item): item is ResourceObservation & { cpuPercent: number } => item.cpuPercent !== undefined);
            const resource = resourceMetrics({ samples: retained.map((item) => ({ atMs: item.atMs, rssBytes: item.rssBytes, cpuPercent: item.cpuPercent })), requestedIntervalMs: 1_000, expectedDurationMs });
            next = { ...raw, observation: raw.metric === "resource.peak_process_family_rss_mib" ? resource.peakRss : resource.cpuP95 };
            validity.push({ check: "resource-sample-coverage", expectedCount: resource.expectedSamples, actualCount: resource.achievedSamples, passed: resource.achievedSamples >= Math.ceil(resource.expectedSamples * 0.95) });
          }
          samples.push(applyValidity(next, validity));
        }
      }
    }
    hostAfter = await captureHostState();
    const transitionFailures = validateHostTransition(hostBefore, hostAfter);
    if (transitionFailures.length) {
      for (let index = 0; index < samples.length; index++) samples[index] = applyValidity(samples[index]!, transitionFailures.map((check) => ({ check, passed: false })));
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (runtime) {
      try { shutdown = await call("shutdown", { reason: failure ? "failed" : "complete" }); }
      catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
    }
    try { await lease?.release(); }
    catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
  }

  const survivorCount = shutdown && typeof shutdown === "object" && "survivors" in shutdown && Array.isArray((shutdown as { survivors: unknown[] }).survivors) ? (shutdown as { survivors: unknown[] }).survivors.length : runtime ? 1 : 0;
  if (survivorCount > 0) {
    failure ??= `${survivorCount} owned process survivor(s)`;
    for (let index = 0; index < samples.length; index++) samples[index] = applyValidity(samples[index]!, [{ check: "zero-process-survivors", expectedCount: 0, actualCount: survivorCount, passed: false }]);
  }
  if (failure || samples.length !== selectedMetrics(options.profiles).length) {
    const existing = new Set(samples.map((sample) => sample.metric));
    for (const [profile, scenario, metric] of selectedMetricTriples(options.profiles)) {
      if (!existing.has(metric)) samples.push(invalidInfrastructureSample(runId, profile, scenario, metric, failure ?? "incomplete-metric-coverage"));
    }
  }
  const summary = summarize(samples, targets);
  const validity = !failure && survivorCount === 0 && samples.length === selectedMetrics(options.profiles).length && samples.every((sample) => sample.validity.status === "valid") ? "valid" : "invalid";
  const manifest = { schemaVersion: 1, runId, application: "Claxedo", startedAt, completedAt: new Date().toISOString(), validity, failure, provenance: { ...provenance, postflight: hostAfter }, processOwnership: { rootPid, snapshots: ownershipSnapshots, shutdown, survivorCount }, samples, summary };
  await Promise.all([
    writeJson(path.join(options.output, "attempt.json"), manifest),
    writeJson(path.join(options.output, "provenance.json"), manifest.provenance),
    writeJson(path.join(options.output, "summary.json"), summary),
    writeFile(path.join(options.output, "summary.md"), markdownSummary(manifest)),
  ]);
  return { manifest, exitCode: validity === "valid" && summary.every((item) => item.passed) ? 0 : 1 };
}

async function runWithProcessSampling<T>(rootPid: number, settleMs: number, memoryHelperPath: string | undefined, task: () => Promise<T>) {
  const observations: ResourceObservation[] = [];
  const failures: string[] = [];
  const tracker = new IdleProcessFamilyTracker(rootPid);
  let sampling = false;
  let settled = settleMs === 0;
  const startedAtMs = performance.now();
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const now = performance.now();
      if (!settled && now - startedAtMs >= settleMs) { tracker.resetSamplingBaseline(); settled = true; }
      const table = await readProcessTable();
      const checks = processChecks(table, rootPid);
      failures.push(...checks.failures);
      const observed = tracker.observe(toIdleRows(table), now);
      if (settled) {
        // Read physical footprint only for the already-discovered family, and
        // only for a sample that will be retained, so the gating RSS sum is
        // derived from exactly the rows it always was and no spawn happens
        // during a settle window. The helper is a child of this runner, never
        // of `rootPid`, so it cannot enter the family or its CPU accounting.
        const family = withPhysFootprint(checks.family, await readPhysFootprint(observed.pids, memoryHelperPath));
        const physFootprintBytes = totalPhysFootprintBytes(family);
        observations.push({ atMs: observed.atMs, rssBytes: observed.rssBytes, ...(physFootprintBytes === undefined ? {} : { physFootprintBytes }), ...(observed.cpuPercent === undefined ? {} : { cpuPercent: observed.cpuPercent }), processes: family });
      }
    } catch (error) { failures.push(`process-sample-failed:${error instanceof Error ? error.message : String(error)}`); }
    finally { sampling = false; }
  };
  await sample();
  const timer = setInterval(() => void sample(), 1_000);
  const value = await task().finally(() => clearInterval(timer));
  await sample();
  return { value, observations, failures: [...new Set(failures)], startedAtMs, endedAtMs: performance.now() };
}

/** Records `ri_phys_footprint` beside the RSS already in an ownership snapshot; a missing helper simply records nothing. */
async function withFootprint(family: readonly ProcessSnapshot[], memoryHelperPath: string | undefined) {
  return withPhysFootprint(family, await readPhysFootprint(family.map((row) => row.pid), memoryHelperPath));
}

function processChecks(table: ProcessSnapshot[], rootPid: number) {
  const family = processFamily(table, rootPid);
  const failures: string[] = [];
  if (!family.some((item) => item.pid === rootPid)) failures.push("application-root-missing");
  const forbidden = [...family, ...processLineage(table, rootPid)].find(isT3Process);
  if (forbidden) failures.push(`forbidden-t3-lineage:${forbidden.pid}`);
  return { family, failures };
}
function assertSurface(surface: InspectResult["surface"]) {
  if (surface.visibilityState !== "visible" || surface.hidden || !surface.focused) throw new Error(`application lost foreground: ${JSON.stringify(surface)}`);
  const viewport = agentAppViewport();
  if (surface.viewport.width !== viewport.width || surface.viewport.height !== viewport.height) throw new Error(`application viewport changed: ${JSON.stringify(surface.viewport)}`);
}
function surfaceEvidence(check: string, surface: InspectResult["surface"]): ValidityCheckEvidence {
  const viewport = agentAppViewport();
  const passed = surface.visibilityState === "visible" && !surface.hidden && surface.focused && surface.viewport.width === viewport.width && surface.viewport.height === viewport.height;
  return { check, expectedCount: 1, actualCount: passed ? 1 : 0, passed };
}
function applyValidity(sample: RawMetricSample, evidence: ValidityCheckEvidence[]): RawMetricSample {
  const combined = [...sample.validity.evidence, ...evidence];
  const failed = combined.filter((item) => !item.passed);
  if (!failed.length && sample.observation.state !== "invalid") return { ...sample, validity: { status: "valid", evidence: combined } };
  return { ...sample, validity: { status: "invalid", evidence: combined, failures: failed.map((item) => ({ code: item.check, message: `Claxedo benchmark validity check failed: ${item.check}`, evidence: [item] })) } };
}
function invalidInfrastructureSample(runId: string, profile: AgentAppProfile, scenario: AgentAppScenario, metric: PrimaryAgentAppMetric, reason: string) {
  return rawMetricSample({ attemptId: `${runId}-${profile}-${scenario}`, profile, scenario, metric, observation: { state: "invalid", reason: `infrastructure:${reason}`.slice(0, 1024) }, evidence: [driverClock({ name: "infrastructure-failure", startTimestamp: 0, endTimestamp: 0, resolutionMs: 0.1, observerMethod: "attempt retained failure before a metric endpoint" })], validityEvidence: [] });
}
function selectedMetricTriples(profiles: AgentAppProfile[]) { return profiles.flatMap((profile) => PROFILE_SCENARIOS[profile].flatMap((scenario) => SCENARIO_METRICS[scenario].map((metric) => [profile, scenario, metric] as const))); }
function selectedMetrics(profiles: AgentAppProfile[]) { return selectedMetricTriples(profiles).map((item) => item[2]); }
function summarize(samples: RawMetricSample[], targets?: Awaited<ReturnType<typeof loadAgentBenchmarkTargets>>) {
  return PRIMARY_AGENT_APP_METRICS.map((metric) => {
    const raw = samples.filter((sample) => sample.metric === metric);
    const valid = raw.filter((sample) => sample.validity.status === "valid" && (sample.observation.state === "exact" || sample.observation.state === "bounded"));
    const values = valid.flatMap((sample) => sample.observation.state === "exact" ? [sample.observation.value] : sample.observation.state === "bounded" ? [sample.observation.upperBound] : []);
    const value = values.length ? values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]! : undefined;
    const target = targets?.absoluteBudgets[metric];
    return { metric, target, totalSamples: raw.length, validSamples: valid.length, excludedInvalidSamples: raw.length - valid.length, value, passed: value !== undefined && !!target && evaluateTarget(target, value) };
  });
}
function markdownSummary(manifest: { runId: string; validity: string; failure?: string; summary: ReturnType<typeof summarize> }) {
  const lines = [`# Claxedo agent-app benchmark ${manifest.runId}`, "", `Attempt validity: **${manifest.validity}**`, ...(manifest.failure ? [`Failure: \`${manifest.failure}\``] : []), "", "| Metric | Valid / total | Result | Target | Gate |", "|---|---:|---:|---:|---|"];
  for (const item of manifest.summary) lines.push(`| \`${item.metric}\` | ${item.validSamples} / ${item.totalSamples} | ${item.value ?? "—"} | ${item.target ? `${item.target.direction} ${item.target.value} ${item.target.unit}` : "—"} | ${item.passed ? "pass" : "fail"} |`);
  lines.push("", "Invalid samples are retained in `attempt.json` and never enter the result column.", "");
  return lines.join("\n");
}
async function resolveExecutable(app: string) {
  const info = await stat(app);
  let executable = app;
  if (info.isDirectory() && app.endsWith(".app")) {
    const name = path.basename(app, ".app");
    executable = path.join(app, "Contents", "MacOS", name);
  }
  await access(executable);
  return await realpath(executable);
}
function isT3Path(value: string) { return /(^|[\/\\])(?:t3|t3code)(?=$|[\/\\.:-])/iu.test(value); }
async function sha256File(file: string) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function hashDriverClosure() {
  const files = (await readdir(import.meta.dir)).filter((name) => name.startsWith("agent-") && name.endsWith(".ts")).toSorted();
  const hash = createHash("sha256");
  for (const name of files) hash.update(name).update("\0").update(await readFile(path.join(import.meta.dir, name))).update("\0");
  return hash.digest("hex");
}
async function hashLocks(repoRoot: string) {
  const paths = [path.join(repoRoot, "bun.lock"), path.join(import.meta.dir, "../bun.lock")];
  const hash = createHash("sha256");
  const files: Array<{ path: string; sha256: string }> = [];
  for (const file of paths) { const digest = await sha256File(file); files.push({ path: file, sha256: digest }); hash.update(file).update(digest); }
  return { sha256: hash.digest("hex"), files };
}
async function sourceProvenance(repoRoot: string) {
  const command = async (args: string[]) => { const child = Bun.spawn({ cmd: ["git", "-C", repoRoot, ...args], stdout: "pipe", stderr: "pipe" }); const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]); if (code !== 0) throw new Error(`git ${args.join(" ")} failed`); return stdout; };
  const commit = (await command(["rev-parse", "HEAD"])).trim();
  const status = await command(["status", "--porcelain=v1", "--", "packages/claxedo-app/perf-harness"]);
  const sourceTreeSha256 = await hashDriverClosure();
  return { applicationCommit: commit, driverCommit: commit, perfHarnessDirty: status.trim().length > 0, perfHarnessStatusSha256: createHash("sha256").update(status).digest("hex"), sourceTreeSha256 };
}
async function prepareOutput(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readdir(directory);
  if (existing.length) throw new Error(`output directory must be empty: ${directory}`);
}
if (import.meta.main) {
  try {
    const result = await runAgentAppBenchmark(parseAgentBenchmarkOptions(process.argv.slice(2)));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
