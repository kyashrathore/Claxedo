#!/usr/bin/env bun

import { cpus, tmpdir } from "node:os"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { readFile, readdir } from "node:fs/promises"
import pidtree from "pidtree"

import { readFiniteNumber } from "@claxedo/helpers/readers"

import { createProcessMetricsSource } from "../src/main/diagnostics/process-metrics-source"
import type { Pidusage } from "../src/main/diagnostics/process-metrics-worker-runtime"
import { createProfiler } from "../src/main/diagnostics/profiler"
import { electronBinary, emptyElectronSource } from "./diagnostics-smoke-sources"

// Named on the binding rather than asserted: `require` answers `any`, so
// the declaration IS the contract for the slice this smoke uses.
const packageUsage: Pidusage = createRequire(import.meta.url)("pidusage")

export async function measureDiagnosticsTreeCpu(enabled: boolean) {
  // EMFILE forensics: this spawn has died with "too many open files" on CI
  // runners even after the /proc scan was reduced to a children walk. Print
  // the live fd count so the next failure shows whether THIS process is
  // leaking (count near the soft limit) or the errno is coming from the
  // system table.
  if (process.platform === "linux") {
    const fdCount = await readdir("/proc/self/fd").then((entries) => entries.length).catch(() => -1)
    console.log(`[diagnostics-smoke] open fds before probe spawn: ${String(fdCount)}`)
  }
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      import.meta.path,
      enabled ? "--enabled" : "--control",
    ],
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH ?? "",
      CLAXEDO_DIAGNOSTICS_WORKER_PATH: resolve(
        import.meta.dirname,
        "../out/main/process-metrics-worker.js",
      ),
    },
    stdout: "pipe",
    stderr: "inherit",
  })
  if (!child.pid) throw new Error("Could not start diagnostics CPU probe")
  try {
    const reader = child.stdout.getReader()
    const ready = await Promise.race([
      reader.read(),
      Bun.sleep(10_000).then(() => {
        throw new Error("Diagnostics CPU probe did not become ready")
      }),
    ])
    reader.releaseLock()
    if (ready.done || !new TextDecoder().decode(ready.value).includes("READY")) {
      throw new Error("Diagnostics CPU probe exited before measurement")
    }
    // pidtree shells out to `ps`; under bun on loaded Linux runners that spawn
    // repeatedly comes back without stdio (child.stdout undefined) and throws
    // even across retries. On Linux, skip the subprocess entirely and walk
    // /proc for the descendant set — same tree, no spawn to fail.
    const procTree = async (root: number) => {
      // Descend via /proc/<pid>/task/*/children instead of scanning ALL of
      // /proc for ppids: a busy runner has thousands of pids and even a
      // sequential stat-file sweep exhausted the process fd table (EMFILE on
      // the next Bun.spawn / on /proc/uptime). The children walk opens files
      // proportional to the probe's own tree, which is a dozen entries.
      const tree = new Set<number>([root])
      const queue = [root]
      while (queue.length > 0) {
        const pid = queue.shift()
        if (pid === undefined) break
        const tasks = await readdir(`/proc/${String(pid)}/task`).catch(() => [] as string[])
        for (const tid of tasks) {
          const children = await readFile(`/proc/${String(pid)}/task/${tid}/children`, "utf8").catch(() => "")
          for (const token of children.trim().split(/\s+/)) {
            const child = Number(token)
            if (Number.isFinite(child) && child > 0 && !tree.has(child)) {
              tree.add(child)
              queue.push(child)
            }
          }
        }
      }
      return [...tree]
    }
    // Callback form inside our own promise, never pidtree's promise API: its
    // Windows PowerShell path can fire the callback with "No matching pid
    // found" OUTSIDE the promise chain (a late second invocation), which
    // surfaces as an UNCAUGHT error a try/catch around the await never sees —
    // it killed the release smoke with the probe demonstrably alive. Here a
    // duplicate callback is a no-op resolve, and an error resolves undefined.
    const pidtreeOnce = (pid: number) =>
      new Promise<number[] | undefined>((resolvePids) => {
        pidtree(pid, { root: true }, (error, pids) => resolvePids(error ? undefined : pids))
      })
    const sampleTree = async () => {
      if (process.platform === "linux") return procTree(child.pid)
      // Windows: no descendant sweep at all. pidtree's PowerShell/CIM path
      // never succeeded on the release runners (every attempt ~15s then "No
      // matching pid found"), and two sweep rounds outlived the probe. The
      // profiler work being measured runs INSIDE the probe process, so the
      // root pid alone still captures the enabled-vs-control overhead; only
      // the (idle) fixture child falls out of the sum.
      if (process.platform === "win32") return [child.pid]
      for (let attempt = 0; attempt < 3; attempt++) {
        const pids = await pidtreeOnce(child.pid)
        if (pids) return pids
        await Bun.sleep(250)
      }
      // The sweep raced process churn on every retry. A dead probe is a real
      // failure; a live one degrades to measuring just the root pid.
      if (child.exitCode === null) return [child.pid]
      throw new Error("Diagnostics CPU probe exited while sampling its process tree")
    }
    // Linux NEVER goes through pidusage: its procfile path is broken for
    // `maxage: 0` — history.set early-returns when maxage <= 0, so the cached
    // entry is always missing, the `again` retry recurses forever, and every
    // iteration opens a fresh /proc/<pid>/stat fd until the process hits
    // EMFILE (observed: 65535 open fds, then the next Bun.spawn dies). Sum
    // utime+stime ticks from /proc directly instead; readFile closes its fd.
    const linuxCpuTicks = async (pids: number[]) => {
      let ticks = 0
      for (const pid of pids) {
        const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => "")
        const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        const utime = Number(tail[11])
        const stime = Number(tail[12])
        if (Number.isFinite(utime)) ticks += utime
        if (Number.isFinite(stime)) ticks += stime
      }
      return ticks
    }
    if (process.platform === "linux") {
      const LINUX_CLOCK_TICKS_PER_SECOND = 100 // CLK_TCK on every mainstream distro/kernel config
      const initial = await sampleTree()
      const startTicks = await linuxCpuTicks(initial)
      const startedAt = performance.now()
      await Bun.sleep(5_000)
      const measured = await sampleTree()
      const endTicks = await linuxCpuTicks(measured)
      const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1_000)
      const corePercent = (Math.max(0, endTicks - startTicks) / LINUX_CLOCK_TICKS_PER_SECOND / elapsedSeconds) * 100
      return Math.min(100, corePercent / Math.max(1, cpus().length))
    }
    // pidusage throws "No matching pid found" when ANY pid in the batch exits
    // between our tree sample and its own /proc read — routine for a probe
    // tree that spawns short-lived children. Query per-pid and drop the dead.
    const usageFor = async (pids: number[]) => {
      const result: Record<number, { cpu: number }> = {}
      for (const pid of pids) {
        const stats = await packageUsage(pid, {
          maxage: 0,
          ...(process.platform === "darwin" ? { usePs: true } : {}),
        }).catch(() => undefined)
        const cpu = readFiniteNumber(stats, "cpu")
        if (cpu !== undefined) result[pid] = { cpu }
      }
      return result
    }
    const initial = await sampleTree()
    await usageFor(initial)
    await Bun.sleep(5_000)
    const measured = await sampleTree()
    const usage = await usageFor(measured)
    return Math.min(
      100,
      measured.reduce((total, pid) => total + Math.max(0, usage[pid]?.cpu ?? 0), 0) /
        Math.max(1, cpus().length),
    )
  } finally {
    if (child.exitCode === null) child.kill()
    await Promise.race([child.exited, Bun.sleep(2_000)])
    packageUsage.clear()
  }
}

async function runCpuProbe(enabled: boolean) {
  const fixture = Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    stdout: "ignore",
    stderr: "ignore",
  })
  if (!fixture.pid) throw new Error("Could not start diagnostics CPU probe fixture")
  const source = enabled
    ? createProcessMetricsSource({
        platform: process.platform,
        electron: emptyElectronSource(),
        workerPath: process.env.CLAXEDO_DIAGNOSTICS_WORKER_PATH,
        workerExecPath: electronBinary(),
      })
    : undefined
  const profiler = source
    ? createProfiler({ source, startupDurationMs: 0, steadyIntervalMs: 2_000 })
    : undefined
  if (profiler) {
    profiler.recordOwnerEvent({
      type: "owner-registered",
      at: Date.now(),
      binding: { pid: process.pid, launchId: "cpu-probe", generation: "cpu-probe" },
      descriptor: {
        ownerId: "diagnostics-cpu-probe",
        ownerGeneration: crypto.randomUUID(),
        ownerOperationId: crypto.randomUUID(),
        launchId: crypto.randomUUID(),
        kind: "harness",
        role: "harness",
        label: "Diagnostics CPU probe",
        pid: fixture.pid,
        capabilities: { stopGracefully: false, killOwnedTree: false },
      },
    })
  }
  console.log("READY")
  // Long lifetime, parent-terminated: the measuring parent kills this probe in
  // its finally as soon as sampling ends, so the sleep is a backstop, not the
  // duration. 8s was too tight for Windows — three cold-start PowerShell
  // pidtree sweeps exceeded it, the probe exited ON SCHEDULE mid-sampling,
  // and the parent misread that as a probe crash.
  await Bun.sleep(60_000)
  profiler?.dispose()
  fixture.kill()
  await Promise.race([fixture.exited, Bun.sleep(2_000)])
}

if (import.meta.main) {
  await runCpuProbe(process.argv.includes("--enabled"))
  process.exit(0)
}
