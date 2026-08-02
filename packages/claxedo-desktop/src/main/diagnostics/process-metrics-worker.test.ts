import { describe, expect, test } from "bun:test"

import {
  collectWindowsAncestry,
  createWindowsProcessMetricsWorker,
  diagnosticsWorkerProcessOptions,
  lowerDiagnosticsWorkerPriority,
  WINDOWS_SNAPSHOT_LIMIT,
  windowsCimCommand,
} from "./process-metrics-worker"
import { createPosixProcessMetricsWorker } from "./process-metrics-worker-runtime"

describe("process metrics worker", () => {
  test("runs host collectors below the UI process priority", () => {
    const calls: Array<{ pid: number; priority: number }> = []
    expect(lowerDiagnosticsWorkerPriority((pid, priority) => calls.push({ pid, priority }))).toBe(true)
    expect(calls).toEqual([{ pid: 0, priority: 10 }])
    expect(lowerDiagnosticsWorkerPriority(() => {
      throw new Error("unsupported")
    })).toBe(false)
  })

  test("batches pidusage, normalizes package CPU, warms identity, and clears history", async () => {
    const calls: number[][] = []
    let clears = 0
    const usage = Object.assign(
      async (pids: number[]) => {
        calls.push(pids)
        return {
          10: { pid: 10, ppid: 1, cpu: 800, memory: 8_192 },
          11: { pid: 11, ppid: 10, cpu: 400, memory: 4_096 },
        }
      },
      { clear: () => clears++ },
    )
    const worker = createPosixProcessMetricsWorker({
      platform: "linux",
      logicalProcessors: 8,
      usage,
      tree: (async () => [
        { pid: 10, ppid: 1 },
        { pid: 11, ppid: 10 },
      ]) as never,
      readLinuxStat: async (pid) =>
        `${String(pid)} (worker secret-free) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${String(pid * 100)} 20`,
    })
    const tree = await worker.reconcile([10])
    const samples = await worker.sample(tree.entries, 0)
    expect(calls).toEqual([[10, 11]])
    expect(samples.map((sample) => sample.cpuMachinePercent)).toEqual([100, 50])
    expect(samples.map((sample) => sample.rssBytes)).toEqual([8_192, 4_096])
    expect(samples[0]?.creation).toMatchObject({ state: "available", source: "linux-proc" })
    worker.dispose()
    expect(clears).toBe(1)
  })

  test("isolates an exited PID without degrading every live process sample", async () => {
    const calls: number[][] = []
    const usage = Object.assign(
      async (pids: number[]) => {
        calls.push(pids)
        if (pids.includes(11)) throw new Error("process exited")
        return { 10: { pid: 10, ppid: 1, cpu: 20, memory: 8_192 } }
      },
      { clear: () => undefined },
    )
    const worker = createPosixProcessMetricsWorker({
      platform: "darwin",
      logicalProcessors: 2,
      usage,
    })

    expect(await worker.sample([
      { pid: 10, ppid: 1, rootPid: 10 },
      { pid: 11, ppid: 10, rootPid: 10 },
    ], 0)).toEqual([{
      pid: 10,
      ppid: 1,
      rootPid: 10,
      creation: { state: "unavailable", reason: "identity-unavailable" },
      cpuMachinePercent: 10,
      rssBytes: 8_192,
    }])
    expect(calls).toEqual([[10, 11], [10], [11]])
  })

  test("bounds fallback calls when pidusage fails systemically", async () => {
    let calls = 0
    const worker = createPosixProcessMetricsWorker({
      platform: "linux",
      usage: Object.assign(
        async () => {
          calls++
          throw new Error("systemic source failure")
        },
        { clear: () => undefined },
      ),
    })
    const entries = Array.from({ length: 512 }, (_, index) => ({
      pid: index + 1,
      ppid: index,
      rootPid: 1,
    }))

    await expect(worker.sample(entries, 0)).rejects.toThrow("sampling failed")
    expect(calls).toBeLessThanOrEqual(9)
  })

  test("uses fixed absolute binaries, non-workspace cwd, and minimal non-secret env", () => {
    const original = process.env.PATH
    process.env.PATH = "/workspace/malicious-bin:TOP_SECRET"
    const posix = diagnosticsWorkerProcessOptions("linux")
    const windows = windowsCimCommand("reviewed-encoded-command", String.raw`D:\Windows`)
    process.env.PATH = original
    expect(posix.executable).toBe("/usr/bin/ps")
    expect(posix.cwd).not.toContain(process.cwd())
    expect(JSON.stringify(posix)).not.toContain("TOP_SECRET")
    expect(windows).toEqual({
      executable: String.raw`D:\Windows/System32/WindowsPowerShell/v1.0/powershell.exe`,
      cwd: String.raw`D:\Windows/Temp`,
      env: {
        SystemRoot: String.raw`D:\Windows`,
        WINDIR: String.raw`D:\Windows`,
        PATH: String.raw`D:\Windows\System32;D:\Windows`,
      },
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", "reviewed-encoded-command"],
    })
    expect(windows.args).not.toContain("-ExecutionPolicy")
  })

  test("uses the Windows addon only for flag-free ancestry and detects its 1024 saturation", async () => {
    let flags = -1
    let cpuCalled = false
    const rows = Array.from({ length: WINDOWS_SNAPSHOT_LIMIT }, (_, index) => ({
      pid: index + 1,
      ppid: index === 0 ? 0 : index,
      name: `ignored-${String(index)}`,
      memory: 123,
      commandLine: "secret argv",
    }))
    const result = await collectWindowsAncestry(
      {
        ProcessDataFlag: { None: 0 },
        getAllProcesses(callback, value) {
          flags = value
          callback(rows)
        },
        getProcessCpuUsage() {
          cpuCalled = true
        },
      },
      [1],
    )
    expect(flags).toBe(0)
    expect(cpuCalled).toBe(false)
    expect(result.truncated).toBe(true)
    expect(result.entries.every((row) => !("name" in row) && !("memory" in row))).toBe(true)
  })

  test("times out a Windows ancestry provider that never replies", async () => {
    await expect(collectWindowsAncestry({
      ProcessDataFlag: { None: 0 },
      getAllProcesses() {},
    }, [1], 5)).rejects.toThrow("timed out")
  })

  test("warms Windows counters, handles PID reuse, and preserves greater-than-4GiB RSS", async () => {
    let time = 0
    let creation = "10"
    let ticks = 0
    const worker = createWindowsProcessMetricsWorker({
      addon: {
        ProcessDataFlag: { None: 0 },
        getAllProcesses(callback) {
          callback([{ pid: 10, ppid: 1 }])
        },
      },
      query: async () => [
        {
          pid: 10,
          ppid: 1,
          creationTicks: creation,
          kernelTicks: String(ticks),
          userTicks: String(ticks),
          rssBytes: "8589934592",
        },
      ],
      logicalProcessors: 2,
      monotonicNow: () => time,
    })
    const entries = (await worker.reconcile([10])).entries
    expect((await worker.sample(entries, 0))[0]).toMatchObject({
      cpuMachinePercent: undefined,
      rssBytes: 8_589_934_592,
    })
    time = 1_000
    ticks = 10_000_000
    expect((await worker.sample(entries, 1_000))[0]?.cpuMachinePercent).toBe(100)
    creation = "11"
    time = 2_000
    expect((await worker.sample(entries, 2_000))[0]?.cpuMachinePercent).toBeUndefined()
  })

  test("prunes Windows CPU history when a process leaves the owned closure", async () => {
    let time = 0
    let ticks = 0
    const worker = createWindowsProcessMetricsWorker({
      addon: {
        ProcessDataFlag: { None: 0 },
        getAllProcesses(callback) {
          callback([{ pid: 10, ppid: 1 }])
        },
      },
      query: async (pids) => pids.map((pid) => ({
        pid,
        ppid: 1,
        creationTicks: "10",
        kernelTicks: String(ticks),
        userTicks: String(ticks),
        rssBytes: "1024",
      })),
      logicalProcessors: 2,
      monotonicNow: () => time,
    })
    const entry = { pid: 10, ppid: 1, rootPid: 10 }

    expect((await worker.sample([entry], 0))[0]?.cpuMachinePercent).toBeUndefined()
    time = 1_000
    ticks = 10_000_000
    expect((await worker.sample([entry], 1_000))[0]?.cpuMachinePercent).toBe(100)
    await worker.sample([], 2_000)
    time = 3_000
    ticks = 20_000_000
    expect((await worker.sample([entry], 3_000))[0]?.cpuMachinePercent).toBeUndefined()
  })

  test("keeps the reviewed CIM protocol bounded, property-limited, and shape-invariant", async () => {
    const script = await Bun.file(new URL("./windows-cim-worker.ps1", import.meta.url)).text()
    expect(script).toContain("$inputPids.Count -gt 512")
    expect(script).toContain('ProcessId = "')
    expect(script).toContain(
      "-Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize",
    )
    expect(script).toContain("rows = @($rows)")
    expect(script).toContain('{"ok":false}')
    expect(script).not.toContain("ProcessId IN")
    expect(script).not.toContain("ExecutionPolicy")
  })

  test("propagates CIM protocol failure so source health cannot become healthy-empty", async () => {
    const worker = createWindowsProcessMetricsWorker({
      addon: {
        ProcessDataFlag: { None: 0 },
        getAllProcesses(callback) {
          callback([{ pid: 10, ppid: 1 }])
        },
      },
      query: async () => {
        throw new Error("raw CIM failure")
      },
    })
    const entries = (await worker.reconcile([10])).entries
    await expect(worker.sample(entries, 0)).rejects.toThrow("raw CIM failure")
  })
})
