#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { agentAppViewport } from "./agent-display-contract"
import { measureSessionActivation } from "./agent-browser-observer"
import { performanceMetricDelta, readPerformanceMetrics } from "./frame-sampler"
import {
  armEventualLatestTurnResponseObservation,
  armMessageResponseObservation,
  type MessageResponseObservation,
} from "./message-response-observer"
import { latencyCases, repoRoot, startRealWebHarness, type BenchmarkCase } from "./real-web-harness"
import { privacySafeResourceName } from "./privacy-safe-resource-name"

type Observation = {
  case: BenchmarkCase
  durationMs: number
  clock: { trustedEventAtMs: number; paintedAtMs: number }
  renderer: Record<string, number>
  messageResponse: MessageResponseObservation
  messageRequest?: { startOffsetMs: number; responseStartOffsetMs: number; responseEndOffsetMs: number }
  resources: Array<{ name: string; startOffsetMs: number; durationMs: number; endOffsetMs: number }>
  observer: { frameCount: number; sampleMsTotal: number; sampleMsMax: number }
}

const outputDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, ".context/compound-engineering/ce-optimize/cold-session-load/runs", `real-web-${Date.now()}`)

const actualSessionDatabasePath = process.env.CLAXEDO_ACTUAL_SESSION_DB?.trim() || undefined
const harness = await startRealWebHarness({ outputDirectory, actualSessionDatabasePath })

try {
  const { page, context, manifest, materialization, requireTarget, requireActivation } = harness
  const control = requireTarget("control")

  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  const observations: Observation[] = []
  const benchmarkCases = latencyCases(manifest.seed)
  for (const benchmarkCase of benchmarkCases) {
    const destination = requireTarget(benchmarkCase.destinationSessionId)
    if (benchmarkCase.sessionState === "warm") await requireActivation(destination, "warm-up")
    await requireActivation(control, "control")

    const finishMessageResponse = armMessageResponseObservation(page, destination.sessionId)
    const pageTimeOriginMs = await page.evaluate(() => {
      performance.setResourceTimingBufferSize(10_000)
      performance.clearResourceTimings()
      return performance.timeOrigin
    })
    const before = await readPerformanceMetrics(cdp)
    const measured = await measureSessionActivation(page as never, destination)
    const after = await readPerformanceMetrics(cdp)
    if (measured.state !== "exact") throw new Error(`${benchmarkCase.caseId} failed: ${measured.reason}`)
    const messageResponse = await finishMessageResponse(benchmarkCase.sessionState === "cold")
    const messageRequest = messageResponse.timing
      ? {
          startOffsetMs: messageResponse.timing.startTimeMs - pageTimeOriginMs - measured.trustedEventAtMs,
          responseStartOffsetMs:
            messageResponse.timing.startTimeMs - pageTimeOriginMs - measured.trustedEventAtMs +
            messageResponse.timing.responseStartMs,
          responseEndOffsetMs:
            messageResponse.timing.startTimeMs - pageTimeOriginMs - measured.trustedEventAtMs +
            messageResponse.timing.responseEndMs,
        }
      : undefined
    // ResourceTiming only publishes completed entries. This wait is outside the
    // measured click duration and lets requests that overlapped stable paint
    // finish before the exact click window is selected.
    await page.waitForTimeout(50)
    const resources = await page.evaluate(
      ({ from, to }) => performance
        .getEntriesByType("resource")
        .map((entry) => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration }))
        .filter((entry) => entry.startTime + entry.duration >= from && entry.startTime <= to),
      { from: measured.trustedEventAtMs, to: measured.paintedAtMs },
    )
    observations.push({
      case: benchmarkCase,
      durationMs: measured.durationMs,
      clock: { trustedEventAtMs: measured.trustedEventAtMs, paintedAtMs: measured.paintedAtMs },
      renderer: performanceMetricDelta(before, after),
      messageResponse,
      messageRequest,
      resources: resources.map((resource) => ({
        name: privacySafeResourceName(resource.name),
        startOffsetMs: resource.startTime - measured.trustedEventAtMs,
        durationMs: resource.duration,
        endOffsetMs: resource.startTime + resource.duration - measured.trustedEventAtMs,
      })),
      observer: {
        frameCount: measured.paintStabilityFrames.length,
        sampleMsTotal: measured.paintStabilityFrames.reduce((sum, frame) => sum + frame.observerSampleMs, 0),
        sampleMsMax: Math.max(...measured.paintStabilityFrames.map((frame) => frame.observerSampleMs)),
      },
    })
  }

  const eventualLatestTurnResponse = {
    checkedSessionCount: 0,
    observedResponseCount: 0,
    totalExpectedPartCount: 0,
    totalObservedPartCount: 0,
    totalMissingPartCount: 0,
    passed: true,
  }
  if (harness.loadKind === "actual-session") {
    for (const benchmarkCase of benchmarkCases) {
      const target = requireTarget(benchmarkCase.destinationSessionId)
      if (!target.eventualFullPartIds) throw new Error(`${benchmarkCase.caseId} has no eventual full-part contract`)
      await requireActivation(control, "eventual-latest-turn-control")
      const finishLatestTurn = armEventualLatestTurnResponseObservation(page, target.sessionId, target.eventualFullPartIds)
      await requireActivation(target, "eventual-latest-turn-target")
      const coverage = await finishLatestTurn()
      eventualLatestTurnResponse.checkedSessionCount += 1
      eventualLatestTurnResponse.observedResponseCount += coverage.observed ? 1 : 0
      eventualLatestTurnResponse.totalExpectedPartCount += coverage.expectedPartCount
      eventualLatestTurnResponse.totalObservedPartCount += coverage.observedPartCount
      eventualLatestTurnResponse.totalMissingPartCount += coverage.missingPartCount
      eventualLatestTurnResponse.passed &&= coverage.passed
    }
  }
  await cdp.detach()
  const workingTreeSha256AtEnd = await harness.currentWorkingTreeDigest()

  const coldObservations = observations.filter((observation) => observation.case.sessionState === "cold")
  const actualSourceAliasCount = harness.loadKind === "actual-session" && "sourceAliasCount" in materialization
    ? materialization.sourceAliasCount
    : undefined
  const coldBackgroundOverlaps = coldObservations.flatMap((observation) =>
    observation.resources.filter((resource) => resource.startOffsetMs < -1),
  )
  const result = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runId: `claxedo-real-web-${harness.loadKind}-${randomUUID()}`,
    sourceCommit: harness.sourceCommit,
    artifacts: { ...harness.artifacts, workingTreeSha256AtEnd },
    surface: "production-local-web",
    browser: "playwright-chromium-headless",
    viewport: agentAppViewport(),
    backend: "packaged-claxedo-desktop-server-and-embedded-opencode",
    syntheticRoutes: false,
    loadKind: harness.loadKind,
    corpus: {
      id: manifest.corpusId,
      digestSha256: materialization.corpusDigestSha256,
      definitionDigestSha256: manifest.definitionDigestSha256,
      eventSchemaDigestSha256: materialization.eventSchemaDigestSha256,
      mappingDigestSha256: materialization.mappingDigestSha256,
      messageCount: materialization.messageCount,
      transcriptBytes: materialization.transcriptBytes,
      ...(harness.loadKind === "actual-session" ? {
        payloadBytes: "payloadBytes" in materialization ? materialization.payloadBytes : undefined,
        sourceDirectoryCount: "sourceDirectoryCount" in materialization ? materialization.sourceDirectoryCount : undefined,
        sourceSessionCount: "sourceSessionCount" in materialization ? materialization.sourceSessionCount : undefined,
        sourceAliasCount: "sourceAliasCount" in materialization ? materialization.sourceAliasCount : undefined,
      } : {}),
    },
    observations,
    eventualLatestTurnResponse,
    networkDiagnostics: {
      coldBackgroundOverlapCount: coldBackgroundOverlaps.length,
      coldBackgroundOverlapByResource: Object.fromEntries(
        [...new Set(coldBackgroundOverlaps.map((resource) => resource.name))].map((name) => [
          name,
          coldBackgroundOverlaps.filter((resource) => resource.name === name).length,
        ]),
      ),
    },
    summary: summarize(observations),
    acceptance: {
      coldClickToStablePaintUnder50Ms: coldObservations.every((observation) => observation.durationMs < 50),
      sourceTreeStayedFrozen: workingTreeSha256AtEnd === harness.artifacts.workingTreeSha256,
      coldMaximumMs: Math.max(...coldObservations.map((observation) => observation.durationMs)),
      coldPayloadsAreIndependent: actualSourceAliasCount === undefined || actualSourceAliasCount === 0,
      coldRequestIsClickOwned: coldObservations.every((observation) =>
        observation.messageResponse.observed &&
        observation.messageResponse.ok &&
        observation.messageRequest !== undefined &&
        observation.messageRequest.startOffsetMs >= -1 &&
        observation.messageRequest.responseEndOffsetMs <= observation.durationMs + 1),
      coldBackgroundContentionFree: coldBackgroundOverlaps.length === 0,
      coldNetworkWaterfallFree: coldObservations.every((observation) =>
        observation.resources.filter((resource) => resource.startOffsetMs >= -1).length === 1 &&
        observation.resources.some((resource) =>
          resource.name === "session-message" &&
          resource.startOffsetMs >= -1 &&
          resource.endOffsetMs <= observation.durationMs + 1)),
    },
  }
  const resultPath = path.join(outputDirectory, "result.json")
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  const verified = JSON.parse(await readFile(resultPath, "utf8")) as typeof result
  if (verified.observations.length !== 40 || Object.keys(verified.summary).length !== 4) {
    throw new Error("real web result verification failed")
  }
  console.log(resultPath)
  if (harness.loadKind === "actual-session" && (
    !result.acceptance.coldClickToStablePaintUnder50Ms ||
    !result.acceptance.sourceTreeStayedFrozen ||
    !result.acceptance.coldPayloadsAreIndependent ||
    !result.acceptance.coldRequestIsClickOwned ||
    !result.acceptance.coldBackgroundContentionFree ||
    !result.acceptance.coldNetworkWaterfallFree ||
    !eventualLatestTurnResponse.passed
  )) {
    throw new Error(
      `strict actual-session acceptance failed: cold maximum ${result.acceptance.coldMaximumMs.toFixed(1)}ms; ` +
      `source-frozen ${result.acceptance.sourceTreeStayedFrozen}; ` +
      `independent payloads ${result.acceptance.coldPayloadsAreIndependent}; ` +
      `click-owned requests ${result.acceptance.coldRequestIsClickOwned}; ` +
      `background-contention-free ${result.acceptance.coldBackgroundContentionFree}; ` +
      `waterfall-free ${result.acceptance.coldNetworkWaterfallFree}; ` +
      `raw latest-turn missing parts ${eventualLatestTurnResponse.totalMissingPartCount}`,
    )
  }
} finally {
  await harness.close()
}

function summarize(observations: Observation[]) {
  return Object.fromEntries([
    "within-workspace-cold",
    "within-workspace-warm",
    "across-workspaces-cold",
    "across-workspaces-warm",
  ].map((lane) => {
    const selected = observations.filter((item) => item.case.id === lane)
    const durations = selected.map((item) => item.durationMs).toSorted((left, right) => left - right)
    const means = (key: string) => selected.reduce((sum, item) => sum + Number(item.renderer[key] ?? 0), 0) / selected.length
    return [lane, {
      count: selected.length,
      completionMs: stats(durations),
      scriptMsMean: means("scriptMs"),
      taskMsMean: means("taskMs"),
      recalcStyleMsMean: means("recalcStyleMs"),
      layoutMsMean: means("layoutMs"),
      heapDeltaBytesMean: means("jsHeapUsedBytes"),
      responseBodyBytesMean: selected.reduce(
        (sum, item) => sum + (item.messageResponse.responseBodyBytes ?? 0),
        0,
      ) / selected.length,
      messageResponseObservedCount: selected.filter((item) => item.messageResponse.observed).length,
    }]
  }))
}

function stats(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return {
    mean,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values[0],
    max: values.at(-1),
    stddev: Math.sqrt(variance),
  }
}

function percentile(values: number[], quantile: number) {
  if (values.length === 0) return Number.NaN
  const index = (values.length - 1) * quantile
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return values[lower]!
  return values[lower]! + (values[upper]! - values[lower]!) * (index - lower)
}
