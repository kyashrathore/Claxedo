#!/usr/bin/env bun

import * as path from "node:path"
import treeKill from "tree-kill"

type Row = {
  command: string
  cpu: number
  pid: number
  ppid: number
  rssKiB: number
}

type Sample = {
  atMs: number
  cpu: number
  roles: Record<string, number>
  rssKiB: number
  systemCpu: number
}

// procps accepts the same BSD-style `ps -axo pid=,ppid=,%cpu=,rss=,command=`
// invocation used below, so the sampler runs unchanged on Linux (e.g. a
// headless container under xvfb-run). Note the %cpu semantics differ: Linux
// reports a lifetime average where macOS reports a recent window, so compare
// CPU figures only within one platform.
if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error("Desktop startup resource profiling requires macOS or Linux ps")
}

const packageDir = path.resolve(import.meta.dir, "..")
const appExecutable = process.env.CLAXEDO_PERF_APP_EXECUTABLE
const sampleIntervalMs = numberEnv("CLAXEDO_PERF_SAMPLE_MS", 250)
const timeoutMs = numberEnv("CLAXEDO_PERF_TIMEOUT_MS", 60_000)
const settleMs = numberEnv("CLAXEDO_PERF_SETTLE_MS", 5_000)
const watchdogIntervalMs = numberEnv("CLAXEDO_PERF_WATCHDOG_INTERVAL_MS", 10)
const captureNativeStacks = process.env.CLAXEDO_PERF_NATIVE_STACKS === "1"
const readyMarker = process.env.CLAXEDO_PERF_READY_MARKER ?? "[startup-perf] session list ready"
const stage = process.env.CLAXEDO_PERF_STAGE ?? "full"
const readySelector = {
  shell: '[data-testid="startup-isolation-shell"]',
  sidebar:
    '[data-testid="rail-sidebar-session-row"], [data-testid="rail-sidebar-session-list-empty"], [data-testid="rail-sidebar-session-list-error"]',
  timeline:
    '[data-session-timeline-root], [data-testid="empty-draft-session-composer"], [data-testid="startup-isolation-timeline"]',
  workspace: '[data-testid="workspace-panel-shell"]',
  full:
    '[data-testid="rail-sidebar-session-row"], [data-testid="rail-sidebar-session-list-empty"], [data-testid="rail-sidebar-session-list-error"]',
}[stage]
if (!readySelector) throw new Error(`Unknown CLAXEDO_PERF_STAGE "${stage}"`)
const budgets = {
  peakCpu: numberEnv("CLAXEDO_PERF_MAX_PEAK_CPU", 700),
  peakMainMiB: numberEnv("CLAXEDO_PERF_MAX_MAIN_RSS_MIB", 512),
  peakRssMiB: numberEnv("CLAXEDO_PERF_MAX_PEAK_RSS_MIB", 3_072),
  readyMs: numberEnv("CLAXEDO_PERF_MAX_READY_MS", 25_000),
  sessionListAfterRendererMs: numberEnv("CLAXEDO_PERF_MAX_SESSION_LIST_AFTER_RENDERER_MS", 100),
  settledRssMiB: numberEnv("CLAXEDO_PERF_MAX_SETTLED_RSS_MIB", 2_800),
  watchdogGapMs: numberEnv("CLAXEDO_PERF_MAX_WATCHDOG_GAP_MS", 250),
}
const userDataDir = process.env.CLAXEDO_PERF_USER_DATA_DIR
const child = Bun.spawn({
  cmd: appExecutable
    ? [appExecutable]
    : [path.join(packageDir, "node_modules/.bin/electron-vite"), "dev"],
  cwd: packageDir,
  env: {
    ...Bun.env,
    CLAXEDO_DEVTOOLS: "0",
    GOMAXPROCS: Bun.env.GOMAXPROCS ?? "2",
    CLAXEDO_PERF_READY_SELECTOR: readySelector,
    ...(userDataDir ? { CLAXEDO_DESKTOP_USER_DATA_DIR: userDataDir } : {}),
  },
  stdout: "pipe",
  stderr: "pipe",
})
const startedAt = performance.now()
let output = ""
const stdout = consume(child.stdout, (chunk) => {
  output += chunk
  process.stdout.write(chunk)
})
const stderr = consume(child.stderr, (chunk) => {
  output += chunk
  process.stderr.write(chunk)
})
const samples: Sample[] = []
const watchdogGaps: number[] = []
let watchdogPrevious = performance.now()
const watchdog = setInterval(() => {
  const now = performance.now()
  watchdogGaps.push(now - watchdogPrevious - watchdogIntervalMs)
  watchdogPrevious = now
}, watchdogIntervalMs)
let readyAt: number | undefined
let failure: unknown
let mainPid: number | undefined
const nativeSamples = new Map<string, { path: string; exited: Promise<number> }>()

try {
  while (performance.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`desktop exited during startup with code ${String(child.exitCode)}`)

    const atMs = performance.now() - startedAt
    const rows = await processRows()
    const tree = processTree(rows, child.pid)
    mainPid = tree.find((row) => role(row) === "main")?.pid ?? mainPid
    if (captureNativeStacks && mainPid && !nativeSamples.has("main")) {
      nativeSamples.set("main", startNativeSample(mainPid, "main"))
    }
    const rendererPid = tree.find((row) => role(row) === "renderer")?.pid
    if (captureNativeStacks && rendererPid && !nativeSamples.has("renderer")) {
      nativeSamples.set("renderer", startNativeSample(rendererPid, "renderer"))
    }
    const gpuPid = tree.find((row) => role(row) === "gpu")?.pid
    if (captureNativeStacks && gpuPid && !nativeSamples.has("gpu")) {
      nativeSamples.set("gpu", startNativeSample(gpuPid, "gpu"))
    }
    const serverPid = tree.find((row) => role(row) === "claxedo-server")?.pid
    if (captureNativeStacks && serverPid && !nativeSamples.has("claxedo-server")) {
      nativeSamples.set("claxedo-server", startNativeSample(serverPid, "claxedo-server"))
    }
    const roles = tree.reduce<Record<string, number>>((totals, row) => {
      const name = role(row)
      totals[name] = (totals[name] ?? 0) + row.rssKiB
      return totals
    }, {})
    samples.push({
      atMs,
      cpu: tree.reduce((total, row) => total + row.cpu, 0),
      rssKiB: tree.reduce((total, row) => total + row.rssKiB, 0),
      roles,
      systemCpu: rows.reduce((total, row) => total + row.cpu, 0),
    })

    if (readyAt === undefined && output.includes(readyMarker)) readyAt = atMs
    if (readyAt !== undefined && atMs - readyAt >= settleMs) break
    await Bun.sleep(sampleIntervalMs)
  }

  if (readyAt === undefined) {
    throw new Error(`desktop did not emit the session/bootstrap marker "${readyMarker}" within ${String(timeoutMs)} ms`)
  }
  const peak = samples.reduce((best, sample) => sample.rssKiB > best.rssKiB ? sample : best)
  const peakCpu = Math.max(...samples.map((sample) => sample.cpu))
  const settled = samples.slice(-Math.max(1, Math.ceil(3_000 / sampleIntervalMs)))
  const settledRssKiB = settled.reduce((total, sample) => total + sample.rssKiB, 0) / settled.length
  const peakMainKiB = Math.max(...samples.map((sample) => sample.roles.main ?? 0))
  const sessionListAfterRendererMs = Number(
    output.match(/\[startup-perf\] session list ready after-renderer=(\d+)ms/)?.[1] ?? Number.NaN,
  )
  const rendererLoadCount = [...output.matchAll(/\[startup-perf\] renderer loaded count=(\d+)/g)]
    .reduce((count, match) => Math.max(count, Number(match[1])), 0)
  const mainLoopGapMs = maximumLogValue(output, /\[startup-perf\] main-loop gap=(\d+)ms/g)
  const rendererLoopGapMs = maximumLogValue(output, /\[startup-perf\] renderer-loop gap=(\d+)ms/g)
  const watchdogGapMs = Math.max(0, ...watchdogGaps)
  const result = {
    stage,
    readyMs: Math.round(readyAt),
    sessionListAfterRendererMs,
    rendererLoadCount,
    peakCpu: round(peakCpu),
    peakSystemCpu: round(Math.max(...samples.map((sample) => sample.systemCpu))),
    watchdogGapMs: round(watchdogGapMs),
    watchdogGapsOver100Ms: watchdogGaps.filter((gap) => gap >= 100).length,
    watchdogGapsOver250Ms: watchdogGaps.filter((gap) => gap >= 250).length,
    mainLoopGapMs,
    rendererLoopGapMs,
    peakRssMiB: mib(peak.rssKiB),
    peakAtMs: Math.round(peak.atMs),
    settledRssMiB: mib(settledRssKiB),
    peakMainRssMiB: mib(peakMainKiB),
    rolePeakRssMiB: Object.fromEntries(
      [...new Set(samples.flatMap((sample) => Object.keys(sample.roles)))]
        .sort()
        .map((name) => [name, mib(Math.max(...samples.map((sample) => sample.roles[name] ?? 0)))]),
    ),
    nativeStackSamples: Object.fromEntries([...nativeSamples].map(([name, sample]) => [name, sample.path])),
    sampleCount: samples.length,
  }
  console.log(`\n[startup-perf] ${JSON.stringify(result, null, 2)}`)

  const violations = [
    result.readyMs > budgets.readyMs ? `ready ${String(result.readyMs)} ms > ${String(budgets.readyMs)} ms` : undefined,
    !Number.isFinite(result.sessionListAfterRendererMs)
      ? "session-list renderer timing marker was missing"
      : result.sessionListAfterRendererMs > budgets.sessionListAfterRendererMs
        ? `session list ${String(result.sessionListAfterRendererMs)} ms after renderer > ${String(budgets.sessionListAfterRendererMs)} ms`
        : undefined,
    result.rendererLoadCount !== 1
      ? `renderer loaded ${String(result.rendererLoadCount)} times; expected exactly once`
      : undefined,
    result.peakCpu > budgets.peakCpu ? `peak CPU ${String(result.peakCpu)}% > ${String(budgets.peakCpu)}%` : undefined,
    result.watchdogGapMs > budgets.watchdogGapMs
      ? `OS scheduler gap ${String(result.watchdogGapMs)} ms > ${String(budgets.watchdogGapMs)} ms`
      : undefined,
    result.peakRssMiB > budgets.peakRssMiB
      ? `peak RSS ${String(result.peakRssMiB)} MiB > ${String(budgets.peakRssMiB)} MiB`
      : undefined,
    result.settledRssMiB > budgets.settledRssMiB
      ? `settled RSS ${String(result.settledRssMiB)} MiB > ${String(budgets.settledRssMiB)} MiB`
      : undefined,
    result.peakMainRssMiB > budgets.peakMainMiB
      ? `Electron main RSS ${String(result.peakMainRssMiB)} MiB > ${String(budgets.peakMainMiB)} MiB`
      : undefined,
  ].filter((item): item is string => !!item)
  if (violations.length > 0) throw new Error(`Desktop startup performance budget failed:\n${violations.join("\n")}`)
} catch (error) {
  failure = error
  throw error
} finally {
  clearInterval(watchdog)
  if (failure && samples.length > 0) {
    console.error(
      `\n[startup-perf] stall diagnostics ${JSON.stringify({
        stage,
        elapsedMs: Math.round(performance.now() - startedAt),
        peakCpu: round(Math.max(...samples.map((sample) => sample.cpu))),
        peakSystemCpu: round(Math.max(...samples.map((sample) => sample.systemCpu))),
        peakRssMiB: mib(Math.max(...samples.map((sample) => sample.rssKiB))),
        watchdogGapMs: round(Math.max(0, ...watchdogGaps)),
        watchdogGapsOver100Ms: watchdogGaps.filter((gap) => gap >= 100).length,
        mainLoopGapMs: maximumLogValue(output, /\[startup-perf\] main-loop gap=(\d+)ms/g),
        rendererLoopGapMs: maximumLogValue(output, /\[startup-perf\] renderer-loop gap=(\d+)ms/g),
        nativeStackSamples: Object.fromEntries([...nativeSamples].map(([name, sample]) => [name, sample.path])),
      }, null, 2)}`,
    )
  }
  if (mainPid) {
    try {
      process.kill(mainPid, "SIGTERM")
    } catch {}
  }
  await Promise.race([child.exited, Bun.sleep(5_000)])
  if (child.exitCode === null) await killTree(child.pid, "SIGTERM")
  await Promise.race([child.exited, Bun.sleep(3_000)])
  if (child.exitCode === null) await killTree(child.pid, "SIGKILL")
  await Promise.race([Promise.all([stdout, stderr]), Bun.sleep(1_000)])
  if (failure) console.error("[startup-perf] failed")
}

async function consume(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    onChunk(decoder.decode(item.value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) onChunk(tail)
}

async function processRows() {
  const result = Bun.spawn({
    cmd: ["ps", "-axo", "pid=,ppid=,%cpu=,rss=,command="],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [text, error, code] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ])
  if (code !== 0) throw new Error(`ps failed: ${error.trim()}`)
  return text.split("\n").flatMap((line): Row[] => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    if (!match) return []
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpu: Number(match[3]),
      rssKiB: Number(match[4]),
      command: match[5] ?? "",
    }]
  })
}

function processTree(rows: Row[], rootPid: number) {
  const pids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    rows.forEach((row) => {
      if (!pids.has(row.ppid) || pids.has(row.pid)) return
      pids.add(row.pid)
      changed = true
    })
  }
  return rows.filter((row) => pids.has(row.pid))
}

function role(row: Row) {
  if (row.command.includes("resources/claxedo-server/") || row.command.includes("out/main/claxedo-server/")) {
    return "claxedo-server"
  }
  if (row.command.includes("process-metrics-worker.js")) return "diagnostics"
  if (row.command.includes("--utility-sub-type=node.mojom.NodeService")) return "claxedo-server"
  if (row.command.includes("--type=renderer")) return "renderer"
  if (row.command.includes("--type=gpu-process")) return "gpu"
  if (row.command.includes("--utility-sub-type=network.mojom.NetworkService")) return "network"
  if (row.command.includes("electron-vite dev") || row.command.includes("electron-vite.js dev")) return "vite"
  if (row.command.includes("Claxedo Dev.app/Contents/MacOS/Claxedo Dev")) return "main"
  return `other:${String(row.pid)}`
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

function mib(kib: number) {
  return round(kib / 1024)
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

function maximumLogValue(output: string, pattern: RegExp) {
  return [...output.matchAll(pattern)].reduce((maximum, match) => Math.max(maximum, Number(match[1])), 0)
}

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL") {
  return new Promise<void>((resolve) => {
    treeKill(pid, signal, () => resolve())
  })
}

function startNativeSample(pid: number, role: string) {
  const outputPath = `/tmp/claxedo-startup-${role}-${String(pid)}.sample.txt`
  const sample = Bun.spawn({
    cmd: ["sample", String(pid), "12", "1", "-file", outputPath],
    stdout: "ignore",
    stderr: "ignore",
  })
  return { path: outputPath, exited: sample.exited }
}
