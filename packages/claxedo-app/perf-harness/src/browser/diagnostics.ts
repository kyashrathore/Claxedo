import { appRoot } from "../storage"
import type { ScenarioId, DiagnosticsOverheadEvidence } from "../types"
import { drain } from "./environment"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Browser } from "playwright-core"

export async function startFlowProfiler(browser: Browser, scenario: ScenarioId) {
  const session = await browser.newBrowserCDPSession()
  const processInfo = await readBrowserProcessInfo(session)
  const rootPids = processInfo.processInfo
    .filter((entry) => entry.type === "browser" && Number.isInteger(entry.id) && entry.id > 0)
    .map((entry) => entry.id)
  if (rootPids.length === 0) throw new Error("Could not resolve the real browser process for diagnostics")

  const directory = await mkdtemp(path.join(tmpdir(), "claxedo-flow-profiler-"))
  const output = path.join(directory, "evidence.json")
  const desktopRoot = path.resolve(appRoot, "../claxedo-desktop")
  const profilerProcess = Bun.spawn({
    cmd: [process.execPath, path.join(desktopRoot, "scripts/performance-diagnostics-smoke.ts"), "--flow-profiler"],
    cwd: desktopRoot,
    env: {
      PATH: Bun.env.PATH ?? "",
      CLAXEDO_DIAGNOSTICS_FLOW_ROOT_PIDS: rootPids.join(","),
      CLAXEDO_DIAGNOSTICS_FLOW_OUTPUT: output,
      CLAXEDO_DIAGNOSTICS_FLOW_SOURCE: "cdp",
      CLAXEDO_DIAGNOSTICS_FLOW_INTERACTIVE: scenario === "launch-project" ? "0" : "1",
      CLAXEDO_DIAGNOSTICS_WORKER_PATH: path.join(desktopRoot, "out/main/process-metrics-worker.js"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void drain(profilerProcess.stderr)
  let sampling = false
  let pendingSample: Promise<void> | undefined
  const sample = () => {
    if (sampling) return
    sampling = true
    pendingSample = readBrowserProcessInfo(session)
      .then((value) => {
        profilerProcess.stdin.write(`${JSON.stringify({
          at: Date.now(),
          processes: value.processInfo,
        })}\n`)
      })
      .catch(() => undefined)
      .finally(() => {
        sampling = false
      })
  }
  sample()
  const sampleTimer = setInterval(sample, scenario === "launch-project" ? 500 : 2_000)
  try {
    await waitForProfilerReady(profilerProcess)
  } catch (error) {
    clearInterval(sampleTimer)
    await pendingSample
    profilerProcess.stdin.end()
    profilerProcess.kill()
    await Promise.race([profilerProcess.exited, Bun.sleep(2_000)])
    await detachBrowserSession(session)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  void drain(profilerProcess.stdout)
  let stopped = false
  return {
    async stop() {
      if (stopped) throw new Error("Diagnostics flow profiler was already stopped")
      stopped = true
      clearInterval(sampleTimer)
      await pendingSample
      profilerProcess.stdin.end()
      const exitCode = await Promise.race([
        profilerProcess.exited,
        Bun.sleep(20_000).then(() => undefined),
      ])
      if (exitCode === undefined) {
        profilerProcess.kill()
        await Promise.race([profilerProcess.exited, Bun.sleep(2_000)])
        throw new Error("Diagnostics flow profiler did not stop cleanly")
      }
      try {
        if (exitCode !== 0) throw new Error(`Diagnostics flow profiler exited with ${String(exitCode)}`)
        const evidence = await Bun.file(output).json() as Record<string, unknown>
        const fields = [
          "retainedBytes",
          "retainedProcesses",
          "droppedTicks",
          "maxSourceDurationMs",
          "maxReconciliationDurationMs",
          "collections",
          "sampleCount",
        ] as const
        if (fields.some((field) => typeof evidence[field] !== "number" || !Number.isFinite(evidence[field]))) {
          throw new Error("Diagnostics flow profiler evidence was incomplete")
        }
        return Object.fromEntries(fields.map((field) => [field, evidence[field]])) as Omit<
          DiagnosticsOverheadEvidence,
          "controlHeadline" | "enabledHeadline"
        >
      } finally {
        await detachBrowserSession(session)
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

async function readBrowserProcessInfo(session: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>) {
  return await Promise.race([
    session.send("SystemInfo.getProcessInfo"),
    Bun.sleep(2_000).then(() => {
      throw new Error("Timed out reading browser process metrics")
    }),
  ]) as {
    processInfo: Array<{ id: number; type: string; cpuTime: number }>
  }
}

async function detachBrowserSession(session: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>) {
  await Promise.race([
    session.detach().catch(() => undefined),
    Bun.sleep(2_000),
  ])
}

async function waitForProfilerReady(profilerProcess: Bun.Subprocess<"pipe", "pipe", "pipe">) {
  const reader = profilerProcess.stdout.getReader()
  let output = ""
  try {
    const deadline = Date.now() + 15_000
    while (!output.includes("\n") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => undefined),
      ])
      if (!chunk || chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!output.includes("READY")) {
    throw new Error(`Diagnostics flow profiler did not become ready: ${output.trim() || "<no output>"}`)
  }
}

export function mergeDiagnosticsRuns(
  runs: Array<Omit<DiagnosticsOverheadEvidence, "controlHeadline" | "enabledHeadline">>,
) {
  if (runs.length === 0) throw new Error("Cannot merge diagnostics evidence without profiler runs")
  return {
    retainedBytes: Math.max(...runs.map((run) => run.retainedBytes)),
    retainedProcesses: Math.max(...runs.map((run) => run.retainedProcesses)),
    droppedTicks: runs.reduce((sum, run) => sum + run.droppedTicks, 0),
    maxSourceDurationMs: Math.max(...runs.map((run) => run.maxSourceDurationMs)),
    maxReconciliationDurationMs: Math.max(...runs.map((run) => run.maxReconciliationDurationMs)),
    collections: runs.reduce((sum, run) => sum + run.collections, 0),
    sampleCount: runs.reduce((sum, run) => sum + run.sampleCount, 0),
  }
}
