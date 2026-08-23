#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Page } from "playwright"
import { agentAppViewport } from "./agent-display-contract"
import { measureSessionActivation } from "./agent-browser-observer"
import { performanceMetricDelta, readPerformanceMetrics } from "./frame-sampler"
import { latencyCases, repoRoot, startRealWebHarness, type BenchmarkCase } from "./real-web-harness"

type Observation = {
  case: BenchmarkCase
  durationMs: number
  clock: { trustedEventAtMs: number; paintedAtMs: number }
  renderer: Record<string, number>
  messageResources: Array<{
    name: string
    startTime: number
    duration: number
    requestStart: number
    responseStart: number
    responseEnd: number
    transferSize: number
    decodedBodySize: number
  }>
}

const outputDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, ".context/compound-engineering/ce-optimize/cold-session-load/runs", `real-web-${Date.now()}`)

const harness = await startRealWebHarness({ outputDirectory })

try {
  const { page, context, manifest, materialization, requireTarget, requireActivation } = harness
  const control = requireTarget("control")

  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  const observations: Observation[] = []
  for (const benchmarkCase of latencyCases(manifest.seed)) {
    const destination = requireTarget(benchmarkCase.destinationSessionId)
    if (benchmarkCase.sessionState === "warm") await requireActivation(destination, "warm-up")
    await requireActivation(control, "control")

    const resourceStart = await page.evaluate(() => performance.now())
    const before = await readPerformanceMetrics(cdp)
    const measured = await measureSessionActivation(page as never, destination)
    const after = await readPerformanceMetrics(cdp)
    if (measured.state !== "exact") throw new Error(`${benchmarkCase.caseId} failed: ${measured.reason}`)
    const messageResources = await readMessageResources(page, resourceStart)
    observations.push({
      case: benchmarkCase,
      durationMs: measured.durationMs,
      clock: { trustedEventAtMs: measured.trustedEventAtMs, paintedAtMs: measured.paintedAtMs },
      renderer: performanceMetricDelta(before, after),
      messageResources,
    })
  }
  await cdp.detach()

  const result = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runId: `claxedo-real-web-${randomUUID()}`,
    sourceCommit: harness.sourceCommit,
    surface: "production-local-web",
    browser: "playwright-chromium-headless",
    viewport: agentAppViewport(),
    backend: "packaged-claxedo-desktop-server-and-embedded-opencode",
    syntheticRoutes: false,
    corpus: {
      id: manifest.corpusId,
      digestSha256: materialization.corpusDigestSha256,
      definitionDigestSha256: manifest.definitionDigestSha256,
      eventSchemaDigestSha256: materialization.eventSchemaDigestSha256,
      mappingDigestSha256: materialization.mappingDigestSha256,
      messageCount: materialization.messageCount,
      transcriptBytes: materialization.transcriptBytes,
    },
    observations,
    summary: summarize(observations),
  }
  const resultPath = path.join(outputDirectory, "result.json")
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  const verified = JSON.parse(await readFile(resultPath, "utf8")) as typeof result
  if (verified.observations.length !== 40 || Object.keys(verified.summary).length !== 4) {
    throw new Error("real web result verification failed")
  }
  console.log(resultPath)
} finally {
  await harness.close()
}

async function readMessageResources(page: Page, startedAt: number) {
  return page.evaluate((minimum) => performance.getEntriesByType("resource")
    .map((entry) => entry as PerformanceResourceTiming)
    .filter((entry) => entry.startTime >= minimum && /\/session\/[^/]+\/message(?:\?|$)/u.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
      requestStart: entry.requestStart,
      responseStart: entry.responseStart,
      responseEnd: entry.responseEnd,
      transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize,
    })), startedAt)
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
