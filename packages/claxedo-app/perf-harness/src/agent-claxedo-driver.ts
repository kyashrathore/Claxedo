#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  completeFirstFold,
  measureSessionActivation,
  measureWarmSwitches,
  paintedContentVerification,
  type PaintedMessage,
  type SessionReadinessTarget,
} from "./agent-browser-observer";
import {
  launchPackagedClaxedo,
  type ClaxedoLaunch,
} from "./agent-claxedo-launcher";
import {
  materializeClaxedoCorpus,
  type AgentAppCorpus,
} from "./agent-corpus-materializer";
import { driverHello, type AgentDriverRequest } from "./agent-driver-contract";
import { createAgentDriverRuntime } from "./agent-driver-runtime";
import { runControlledStreamScenario } from "./agent-stream-scenario";
import { runTerminalScenario } from "./agent-terminal-scenario";
import {
  driverClock,
  rawMetricSample,
  rendererClock,
  type ClockEvidence,
  type RawMetricSample,
} from "./agent-samples";
import type { AgentMetricValue, PrimaryAgentAppMetric } from "./agent-metrics";

type Prepared = Awaited<ReturnType<typeof materializeClaxedoCorpus>> & {
  runDirectory: string;
  dataDirectory: string;
  workspaceDirectory: string;
  /** Shared in-flight promise: terminal input/output scenarios are dispatched
   * concurrently, so caching only the settled value launches the workload twice. */
  terminalResult?: ReturnType<typeof runTerminalScenario>;
};

export async function createClaxedoAgentDriver(input?: {
  executable?: string;
  applicationVersion?: string;
  driverDigestSha256?: string;
}) {
  const driverDigestSha256 =
    input?.driverDigestSha256 ??
    createHash("sha256")
      .update(await readFile(import.meta.path))
      .digest("hex");
  let prepared: Prepared | undefined;
  let launch: ClaxedoLaunch | undefined;

  const requirePrepared = () => {
    if (!prepared) throw new Error("Claxedo benchmark driver is not prepared");
    return prepared;
  };
  const requireLaunch = () => {
    if (!launch)
      throw new Error("Claxedo benchmark application is not launched");
    return launch;
  };

  return createAgentDriverRuntime({
    hello: () =>
      driverHello({
        applicationVersion: input?.applicationVersion ?? "0.0.1",
        driverVersion: "1",
        driverDigestSha256,
        applicationSourceCommit: process.env.CLAXEDO_BENCHMARK_APP_COMMIT,
        driverSourceCommit: process.env.CLAXEDO_BENCHMARK_DRIVER_COMMIT,
      }),
    prepare: async (params) => {
      if (prepared)
        throw new Error("Claxedo benchmark driver is already prepared");
      const dataDirectory = path.join(params.runDirectory, "claxedo-data");
      const workspaceDirectory = path.join(params.runDirectory, "workspace");
      prepared = {
        ...(await materializeClaxedoCorpus({
          corpusPath: params.corpusPath,
          corpusDigestSha256: params.corpusDigestSha256,
          dataDirectory,
          workspaceDirectory,
          profiles: params.profiles,
        })),
        runDirectory: params.runDirectory,
        dataDirectory,
      };
      return { coverage: prepared.coverage };
    },
    launch: async ({ isolatedProfilePath }) => {
      const state = requirePrepared();
      if (launch)
        throw new Error("Claxedo benchmark application is already launched");
      launch = await launchPackagedClaxedo({
        executable: input?.executable ?? (await discoverPackagedExecutable()),
        isolatedProfilePath,
        dataDirectory: state.dataDirectory,
        readinessTargets: state.readinessTargets,
      });
      return {
        processes: [launch.process],
        automationReady: true,
        readinessEvidence:
          "packaged Claxedo semantic work surface, two animation frames, and trusted keyboard input",
      };
    },
    runScenario: async (params) => ({
      samples: await runScenarioSafely(
        requirePrepared(),
        requireLaunch(),
        params,
      ),
    }),
    inspect: async () => await requireLaunch().inspect(),
    shutdown: async () => {
      const current = launch;
      const result = current
        ? await current.shutdown()
        : { terminated: [], survivors: [], forced: [] };
      launch = undefined;
      prepared = undefined;
      return result;
    },
  });
}


function canonicalContentCheck(
  target: SessionReadinessTarget | undefined,
  semantic: PaintedMessage,
) {
  if (!target)
    return {
      check: "canonical-content-sha256",
      actualSha256: semantic.contentSha256,
      passed: false,
    };
  const verification = paintedContentVerification(semantic, target);
  return {
    check: "canonical-content-sha256",
    mode: verification.mode,
    expectedSha256:
      "expectedSha256" in verification ? verification.expectedSha256 : undefined,
    actualSha256: semantic.contentSha256,
    passed: verification.passed,
  };
}

async function runScenarioSafely(
  prepared: Prepared,
  launch: ClaxedoLaunch,
  params: Extract<AgentDriverRequest, { method: "run-scenario" }>["params"],
) {
  try {
    return await runScenario(prepared, launch, params);
  } catch (cause) {
    const reason =
      `scenario-failed:${cause instanceof Error ? cause.message : String(cause)}`.slice(
        0,
        1_024,
      );
    return scenarioMetrics(params.scenario).map((metric) =>
      invalidActionSample(params, metric, reason),
    );
  }
}

function scenarioMetrics(
  scenario: Extract<
    AgentDriverRequest,
    { method: "run-scenario" }
  >["params"]["scenario"],
): PrimaryAgentAppMetric[] {
  if (scenario === "app-cold-ready-v1") return ["app.cold_ready_ms"];
  if (scenario === "work-item-cold-open-v1") return ["work_item.cold_open_ms"];
  if (scenario === "work-item-warm-switch-v1")
    return ["work_item.warm_switch_p95_ms"];
  if (scenario === "controlled-stream-v1")
    return ["stream.interaction_p95_ms", "stream.blocked_frame_ratio_pct"];
  if (scenario === "terminal-input-v1")
    return ["terminal.input_to_paint_p95_ms"];
  if (scenario === "terminal-output-v1") return ["terminal.output_mib_s"];
  if (scenario === "resource-sweep-v1")
    return ["resource.peak_process_family_rss_mib"];
  return ["resource.quiescent_cpu_p95_pct"];
}

async function runScenario(
  prepared: Prepared,
  launch: ClaxedoLaunch,
  params: Extract<AgentDriverRequest, { method: "run-scenario" }>["params"],
): Promise<RawMetricSample[]> {
  if (params.scenario === "app-cold-ready-v1") {
    const readiness = launch.coldReady;
    return [
      sample({
        params,
        metric: "app.cold_ready_ms",
        observation: {
          state: "exact",
          value: readiness.durationMs,
          unit: "ms",
        },
        evidence: [
          driverClock({
            name: "packaged-spawn-to-input-ready",
            startTimestamp: readiness.startTimestamp,
            endTimestamp: readiness.endTimestamp,
            resolutionMs: readiness.resolutionMs,
            observerMethod:
              "Bun spawn through semantic surface, two renderer frames, and trusted Tab acceptance",
          }),
        ],
        validity: [
          {
            check: "trusted-input-accepted",
            expectedCount: 1,
            actualCount: readiness.trustedInputAccepted ? 1 : 0,
            passed: readiness.trustedInputAccepted,
          },
          canonicalContentCheck(prepared.readinessTargets[0], readiness.semantic),
          {
            check: "visible-enabled-composer",
            expectedCount: 1,
            actualCount: readiness.semantic.composerVisibleAndEnabled ? 1 : 0,
            passed: readiness.semantic.composerVisibleAndEnabled,
          },
          {
            check: "focused-non-inert-surface",
            expectedCount: 1,
            actualCount: readiness.semantic.surfaceFocused ? 1 : 0,
            passed: readiness.semantic.surfaceFocused,
          },
          {
            check: "renderer-reload-count",
            expectedCount: 0,
            actualCount: readiness.reloadCount,
            passed: readiness.reloadCount === 0,
          },
          {
            check: "renderer-crash-count",
            expectedCount: 0,
            actualCount: readiness.crashCount,
            passed: readiness.crashCount === 0,
          },
        ],
      }),
    ];
  }
  if (params.scenario === "work-item-cold-open-v1") {
    // Launch consumes target 0 to prove strict cold readiness. Target 1 has
    // never been activated, so the cold-open metric cannot silently become a
    // warm reopen of the launch endpoint.
    const readinessTarget = prepared.readinessTargets[1];
    if (!readinessTarget)
      throw new Error("cold open requires a second, never-opened materialized session");
    const action = await measureSessionActivation(launch.page, readinessTarget);
    if (action.state !== "exact")
      return [
        invalidActionSample(params, "work_item.cold_open_ms", action.reason),
      ];
    return [
      sample({
        params,
        metric: "work_item.cold_open_ms",
        observation: { state: "exact", value: action.durationMs, unit: "ms" },
        evidence: [
          actionClock(
            "trusted-session-click-to-stable-semantic-paint",
            action.trustedEventAtMs,
            action.paintedAtMs,
          ),
        ],
        validity: [
          {
            check: "target-session-visible",
            expectedCount: 1,
            actualCount: 1,
            passed: true,
          },
          {
            check: "canonical-latest-turn-stable-and-visible",
            expectedCount: 1,
            actualCount: 1,
            passed: true,
          },
        ],
      }),
    ];
  }
  if (params.scenario === "work-item-warm-switch-v1") {
    const result = await measureWarmSwitches(
      launch.page,
      prepared.readinessTargets,
      seedNumber(params.seed),
    );
    const actions = ("actions" in result ? result.actions : undefined) ?? [];
    const evidence = actions.map((action, sequence) =>
      rendererClock({
        sequence,
        name: "trusted-session-switch-to-stable-paint",
        startTimestamp: action.trustedEventAtMs,
        endTimestamp: action.paintedAtMs,
        observerMethod:
          "trusted CDP click through two identical animation-frame snapshots containing a canonical latest-turn message and complete first fold",
      }),
    );
    return [
      sample({
        params,
        metric: "work_item.warm_switch_p95_ms",
        observation: result.metric,
        evidence:
          evidence.length > 0
            ? evidence
            : [emptyRendererClock("warm-switch-invalid")],
        validity: [
          {
            check: "switch-count",
            expectedCount: 20,
            actualCount: actions.length,
            passed: actions.length === 20,
          },
          {
            check: "canonical-latest-turn-stable-and-visible-count",
            expectedCount: 20,
            actualCount: actions.filter(
              (action) => action.paintedMessage.textLength > 0,
            ).length,
            passed:
              actions.length === 20 &&
              actions.every((action) => action.paintedMessage.textLength > 0),
          },
          {
            check: "complete-visible-first-fold-count",
            expectedCount: 20,
            actualCount: actions.filter((action) =>
              completeFirstFold(action.paintedMessage.timelineCoverage),
            ).length,
            passed:
              actions.length === 20 &&
              actions.every((action) =>
                completeFirstFold(action.paintedMessage.timelineCoverage),
              ),
          },
        ],
      }),
    ];
  }
  if (params.scenario === "controlled-stream-v1") {
    const result = await runControlledStreamScenario({
      page: launch.page,
      serverUrl: launch.serverUrl,
      workspaceDirectory: prepared.workspaceDirectory,
      corpus: prepared.corpus,
      materializedSessions: prepared.materializedSessions,
      materializedParts: prepared.materializedParts,
      readinessTargets: prepared.readinessTargets,
    });
    const evidence = result.evidence
      ? [
          rendererClock({
            name: "controlled-stream-window",
            startTimestamp: result.evidence.startedAtMs,
            endTimestamp: result.evidence.endedAtMs,
            observerMethod:
              "renderer Event Timing and Long Animation Frame observers during canonical session part updates",
          }),
        ]
      : [emptyRendererClock("stream-observer-invalid")];
    const validity = [
      {
        check: "stream-event-count",
        expectedCount: result.validity.expectedEvents,
        actualCount: result.validity.actualEvents,
        passed: result.validity.expectedEvents === result.validity.actualEvents,
      },
      {
        check: "stream-probe-count",
        expectedCount: result.validity.expectedProbes,
        actualCount: result.validity.actualProbes,
        passed: result.validity.expectedProbes === result.validity.actualProbes,
      },
      {
        check: "stream-final-content",
        expectedCount: 1,
        actualCount: result.validity.finalContentMatched ? 1 : 0,
        passed: result.validity.finalContentMatched,
      },
    ];
    return [
      sample({
        params,
        metric: "stream.interaction_p95_ms",
        observation: result.interaction,
        evidence,
        validity,
      }),
      sample({
        params,
        metric: "stream.blocked_frame_ratio_pct",
        observation: result.blockedFrames,
        evidence,
        validity,
      }),
    ];
  }
  if (
    params.scenario === "terminal-input-v1" ||
    params.scenario === "terminal-output-v1"
  ) {
    const stream = terminalStream(prepared.corpus);
    const result = await (prepared.terminalResult ??=
      runTerminalScenario({
        page: launch.page,
        runDirectory: prepared.runDirectory,
        stream,
      }));
    const terminalEvidence = result.evidence;
    const evidence =
      terminalEvidence && !("state" in terminalEvidence)
        ? params.scenario === "terminal-input-v1"
          ? terminalEvidence.inputWindows.map((window, sequence) =>
              rendererClock({
                sequence,
                name: "terminal-key-to-echo-paint",
                ...window,
                observerMethod:
                  "trusted terminal key event through xterm parsed-model receipt and two animation frames",
              }),
            )
          : [
              rendererClock({
                name: "terminal-first-client-write-to-final-model-paint",
                startTimestamp: terminalEvidence.acceptedAtMs,
                endTimestamp: terminalEvidence.paintedAtMs,
                observerMethod:
                  "terminal client write acceptance through exact framed output and serialized xterm model paint",
              }),
            ]
        : [emptyRendererClock("terminal-observer-invalid")];
    const rawOutputMatched =
      terminalEvidence &&
      !("state" in terminalEvidence) &&
      terminalEvidence.outputHash === result.workload.expectedSha256 &&
      terminalEvidence.bytes === result.workload.expectedBytes;
    const validity = [
      {
        check: "terminal-output-sha256",
        expectedSha256: result.workload.expectedSha256,
        actualSha256:
          terminalEvidence && !("state" in terminalEvidence)
            ? terminalEvidence.outputHash
            : undefined,
        expectedCount: result.workload.expectedBytes,
        actualCount:
          terminalEvidence && !("state" in terminalEvidence)
            ? terminalEvidence.bytes
            : 0,
        passed: !!rawOutputMatched,
      },
      {
        check: "terminal-geometry",
        expectedCount: (result.workload.expectedColumns ?? 0) * (result.workload.expectedRows ?? 0),
        actualCount: (result.workload.actualColumns ?? 0) * (result.workload.actualRows ?? 0),
        passed: result.workload.geometryMatched,
      },
      {
        check: "terminal-model-sha256",
        expectedSha256: result.workload.expectedModelHash,
        actualSha256: result.workload.actualModelHash,
        passed: result.workload.modelMatched,
      },
      // Informational, never failing: every run contributes the `bytesFromEnd` of
      // any echo that arrived beyond the observer's 64 KiB gate window, so the
      // distribution accumulates in the artifacts at zero host cost. Absent entry
      // means every echo was within the window.
      ...(terminalEvidence && !("state" in terminalEvidence)
        ? terminalEvidence.echoTailMisses.map((miss, index) => ({
            check: `terminal-echo-beyond-64k-tail-${String(index)}`,
            expectedCount: 65_536,
            actualCount: miss.bytesFromEnd,
            passed: true,
          }))
        : []),
    ];
    const terminalSample = sample({
      params,
      metric:
        params.scenario === "terminal-input-v1"
          ? "terminal.input_to_paint_p95_ms"
          : "terminal.output_mib_s",
      observation:
        params.scenario === "terminal-input-v1"
          ? (result.inputMetric ?? result.metric)
          : result.metric,
      evidence:
        evidence.length > 0
          ? evidence
          : [emptyRendererClock("terminal-input-invalid")],
      validity,
    });
    return [terminalSample];
  }
  if (params.scenario === "resource-sweep-v1") {
    const startTimestamp = performance.now();
    const sweep = await measureWarmSwitches(
      launch.page,
      prepared.readinessTargets,
      seedNumber(params.seed),
    );
    if (sweep.metric.state !== "exact") {
      throw new Error(
        `resource sweep did not complete its canonical workload: ${sweep.metric.reason}`,
      );
    }
    const endTimestamp = performance.now();
    return [
      runnerOwnedResourceSample(
        params,
        "resource.peak_process_family_rss_mib",
        startTimestamp,
        endTimestamp,
      ),
    ];
  }
  const measurementStart = performance.now();
  // The shared runner owns this full 75-second boundary: it discards the first
  // 15 seconds as settle time and derives p95 only from the following 60.
  await Bun.sleep(75_000);
  const endTimestamp = performance.now();
  return [
    runnerOwnedResourceSample(
      params,
      "resource.quiescent_cpu_p95_pct",
      measurementStart,
      endTimestamp,
      true,
    ),
  ];
}

function sample(input: {
  params: Extract<AgentDriverRequest, { method: "run-scenario" }>["params"];
  metric: PrimaryAgentAppMetric;
  observation: AgentMetricValue;
  evidence: ClockEvidence[];
  validity: Parameters<typeof rawMetricSample>[0]["validityEvidence"];
}) {
  return rawMetricSample({
    attemptId: input.params.attemptId,
    profile: input.params.profile,
    scenario: input.params.scenario,
    metric: input.metric,
    observation: input.observation,
    evidence: input.evidence,
    validityEvidence: input.validity,
  });
}

function actionClock(
  name: string,
  startTimestamp: number,
  endTimestamp: number,
) {
  return rendererClock({
    name,
    startTimestamp,
    endTimestamp,
    observerMethod:
      "trusted CDP click through matching semantic readiness and two animation frames",
  });
}

function emptyRendererClock(name: string) {
  return rendererClock({
    name,
    startTimestamp: 0,
    endTimestamp: 0,
    observerMethod: "observer failed before a measurable interval",
  });
}

function invalidActionSample(
  params: Extract<AgentDriverRequest, { method: "run-scenario" }>["params"],
  metric: PrimaryAgentAppMetric,
  reason: string,
) {
  return sample({
    params,
    metric,
    observation: { state: "invalid", reason },
    evidence: [emptyRendererClock("invalid-action")],
    validity: [],
  });
}

function runnerOwnedResourceSample(
  params: Extract<AgentDriverRequest, { method: "run-scenario" }>["params"],
  metric:
    | "resource.peak_process_family_rss_mib"
    | "resource.quiescent_cpu_p95_pct",
  startTimestamp: number,
  endTimestamp: number,
  quiescent = false,
) {
  return sample({
    params,
    metric,
    observation: {
      state: "unsupported",
      reason: "shared-runner-process-observer-owns-value",
    },
    evidence: [
      driverClock({
        name: quiescent
          ? "resource-quiescent-measurement-window"
          : "resource-active-sweep-window",
        startTimestamp,
        endTimestamp,
        resolutionMs: 0.1,
        observerMethod: !quiescent
          ? "seeded 20-work-item sweep while the shared runner samples the declared process family"
          : "action-free 60-second shared-runner observation after the prior scenario's 15-second settle gate",
      }),
    ],
    validity: [
      {
        check: "shared-resource-observer-boundary",
        expectedCount: 1,
        actualCount: 1,
        passed: true,
      },
    ],
  });
}

function terminalStream(corpus: AgentAppCorpus) {
  const stream = corpus.sessions.toSorted(
    (left, right) => left.order - right.order,
  )[0]?.terminalStreams[0];
  if (
    !stream ||
    typeof stream.id !== "string" ||
    !Array.isArray(stream.chunks) ||
    !Array.isArray(stream.inputSentinels)
  ) {
    throw new Error("terminal scenario requires a corpus terminal stream");
  }
  return stream as Parameters<typeof runTerminalScenario>[0]["stream"];
}

function seedNumber(seed: string) {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32LE(0);
}

async function discoverPackagedExecutable() {
  const configured = process.env.CLAXEDO_BENCHMARK_EXECUTABLE?.trim();
  if (configured) {
    await access(configured);
    return path.resolve(configured);
  }
  const desktop = path.resolve(import.meta.dir, "../../../claxedo-desktop");
  const productName =
    process.env.CLAXEDO_CHANNEL === "prod" ? "Claxedo" : "Claxedo Dev";
  const suffix = process.arch === "arm64" ? "-arm64" : "";
  const candidate =
    process.platform === "darwin"
      ? path.join(
          desktop,
          "dist",
          `mac${suffix}`,
          `${productName}.app`,
          "Contents",
          "MacOS",
          productName,
        )
      : process.platform === "win32"
        ? path.join(
            desktop,
            "dist",
            `win${suffix}-unpacked`,
            `${productName}.exe`,
          )
        : path.join(desktop, "dist", `linux${suffix}-unpacked`, "claxedo");
  try {
    await access(candidate);
    return candidate;
  } catch {
    throw new Error(
      `Packaged Claxedo executable is missing at ${candidate}; build/package Claxedo or set CLAXEDO_BENCHMARK_EXECUTABLE`,
    );
  }
}

export async function runClaxedoAgentDriverStdio() {
  const runtime = await createClaxedoAgentDriver();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines)
    process.stdout.write(`${JSON.stringify(await runtime.handle(line))}\n`);
}

if (import.meta.main) await runClaxedoAgentDriverStdio();
