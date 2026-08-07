import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import {
  collectWindowsAncestry,
  createWindowsCimQuery,
  createWindowsProcessMetricsWorker,
  diagnosticsWorkerProcessOptions,
  lowerDiagnosticsWorkerPriority,
  WINDOWS_SNAPSHOT_LIMIT,
  windowsCimCommand,
} from "./process-metrics-worker"
import {
  createPosixProcessMetricsWorker,
  parseLinuxPssBytes,
  parseMacMemoryImpact,
} from "./process-metrics-worker-runtime"

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
      readLinuxSmapsRollup: async (pid) => `Rss: ${String(pid)} kB\nPss: ${String(pid * 2)} kB\n`,
    })
    const tree = await worker.reconcile([10])
    const samples = await worker.sample(tree.entries, 0)
    expect(calls).toEqual([[10, 11]])
    expect(samples.map((sample) => sample.cpuMachinePercent)).toEqual([100, 50])
    expect(samples.map((sample) => sample.rssBytes)).toEqual([8_192, 4_096])
    expect(samples.map((sample) => sample.memoryImpact)).toEqual([
      { kind: "pss", bytes: 20 * 1_024 },
      { kind: "pss", bytes: 22 * 1_024 },
    ])
    expect(samples[0]?.creation).toMatchObject({ state: "available", source: "linux-proc" })
    worker.dispose()
    expect(clears).toBe(1)
  })

  test("parses native memory impact without accepting unrelated totals", () => {
    expect(parseLinuxPssBytes("Rss: 200 kB\nPss: 125 kB\nPss_Anon: 100 kB\n")).toBe(128_000)
    expect(parseMacMemoryImpact("50161 2456765232\n69239 2736560\nsummary 2459452640\n")).toEqual(
      new Map([[50161, 2_456_765_232], [69239, 2_736_560]]),
    )
  })

  test("reuses macOS physical-footprint samples between bounded probe intervals", async () => {
    let probes = 0
    const worker = createPosixProcessMetricsWorker({
      platform: "darwin",
      usage: Object.assign(
        async () => ({ 10: { pid: 10, ppid: 1, cpu: 1, memory: 8_192 } }),
        { clear: () => undefined },
      ),
      readMacMemoryImpact: async () => {
        probes++
        return new Map([[10, 7_000 + probes]])
      },
      memoryImpactIntervalMs: 10_000,
    })
    const entries = [{ pid: 10, ppid: 1, rootPid: 10 }]

    expect((await worker.sample(entries, 0))[0]?.memoryImpact?.bytes).toBe(7_001)
    expect((await worker.sample(entries, 2_000))[0]?.memoryImpact?.bytes).toBe(7_001)
    expect((await worker.sample(entries, 10_000))[0]?.memoryImpact?.bytes).toBe(7_002)
    expect(probes).toBe(2)
  })

  test("reuses Linux proportional-set-size samples between bounded probe intervals", async () => {
    let probes = 0
    const worker = createPosixProcessMetricsWorker({
      platform: "linux",
      usage: Object.assign(
        async () => ({ 10: { pid: 10, ppid: 1, cpu: 1, memory: 8_192 } }),
        { clear: () => undefined },
      ),
      readLinuxStat: async () => "10 (worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 1000 20",
      readLinuxSmapsRollup: async () => `Pss: ${String(++probes)} kB\n`,
      memoryImpactIntervalMs: 10_000,
    })
    const entries = [{ pid: 10, ppid: 1, rootPid: 10 }]

    expect((await worker.sample(entries, 0))[0]?.memoryImpact?.bytes).toBe(1_024)
    expect((await worker.sample(entries, 2_000))[0]?.memoryImpact?.bytes).toBe(1_024)
    expect((await worker.sample(entries, 10_000))[0]?.memoryImpact?.bytes).toBe(2_048)
    expect(probes).toBe(2)
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
      readMacMemoryImpact: async () => new Map([[10, 7_000]]),
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
      memoryImpact: { kind: "physical-footprint", bytes: 7_000 },
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
    // Composed with the same `join` the implementation uses: its separator is
    // host-dependent (/ here, \ on the Windows release runner), and the policy
    // under test is the PATH SHAPE (absolute, under systemRoot), not the
    // separator flavor.
    expect(windows).toEqual({
      executable: join(String.raw`D:\Windows`, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      cwd: join(String.raw`D:\Windows`, "Temp"),
      env: {
        SystemRoot: String.raw`D:\Windows`,
        WINDIR: String.raw`D:\Windows`,
        PATH: String.raw`D:\Windows\System32;D:\Windows`,
      },
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", "reviewed-encoded-command"],
    })
    expect(windows.args).not.toContain("-ExecutionPolicy")
  })

  test("without the optional addon, reconcile still reports the roots so sampling is not blinded", async () => {
    // The addon is an optionalDependency bun may skip. Returning NO entries
    // here silently blinds the whole Windows source: `entries` is the set the
    // caller samples, so no process reaches a snapshot and every owner looks
    // unregistered — which is exactly how the release smoke failed with
    // {"found":false} and no other signal.
    const worker = createWindowsProcessMetricsWorker({
      query: async (pids) => pids.map((pid) => ({
        pid,
        ppid: 1,
        creationTicks: "10",
        kernelTicks: "0",
        userTicks: "0",
        rssBytes: "1024",
      })),
    })

    const reconciled = await worker.reconcile([42, 43])
    expect(reconciled.entries.map((entry) => entry.pid)).toEqual([42, 43])
    // Incomplete, not absent: descendants are missing without the addon.
    expect(reconciled.truncated).toBe(true)
    // And the roots are actually sampleable, which is the point.
    expect((await worker.sample(reconciled.entries, 0)).map((sample) => sample.pid)).toEqual([42, 43])
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
          memoryImpactBytes: "4294967296",
        },
      ],
      logicalProcessors: 2,
      monotonicNow: () => time,
    })
    const entries = (await worker.reconcile([10])).entries
    expect((await worker.sample(entries, 0))[0]).toMatchObject({
      cpuMachinePercent: undefined,
      rssBytes: 8_589_934_592,
      memoryImpact: { kind: "private-working-set", bytes: 4_294_967_296 },
    })
    time = 1_000
    ticks = 10_000_000
    expect((await worker.sample(entries, 1_000))[0]?.cpuMachinePercent).toBe(100)
    creation = "11"
    time = 2_000
    expect((await worker.sample(entries, 2_000))[0]?.cpuMachinePercent).toBeUndefined()
  })

  test("queries Windows private working set only on the bounded memory-impact cadence", async () => {
    const impactFlags: boolean[] = []
    const worker = createWindowsProcessMetricsWorker({
      query: async (_, options) => {
        impactFlags.push(options?.memoryImpact === true)
        return [{
          pid: 10,
          ppid: 1,
          creationTicks: "10",
          kernelTicks: "0",
          userTicks: "0",
          rssBytes: "8192",
          ...(options?.memoryImpact ? { memoryImpactBytes: "4096" } : {}),
        }]
      },
      memoryImpactIntervalMs: 10_000,
    })
    const entries = [{ pid: 10, ppid: 1, rootPid: 10 }]

    expect((await worker.sample(entries, 0))[0]?.memoryImpact).toEqual({
      kind: "private-working-set",
      bytes: 4_096,
    })
    expect((await worker.sample(entries, 2_000))[0]?.memoryImpact?.bytes).toBe(4_096)
    expect((await worker.sample(entries, 10_000))[0]?.memoryImpact?.bytes).toBe(4_096)
    expect(impactFlags).toEqual([true, false, true])
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
    expect(script).toContain("Win32_PerfRawData_PerfProc_Process")
    expect(script).toContain("WorkingSetPrivate")
    expect(script).toContain('ProcessId = "')
    expect(script).toContain(
      "-Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize",
    )
    expect(script).toContain("rows = @($rows)")
    expect(script).toContain("ok = $false; reason = $reason")
    expect(script).toContain("$reason.Substring(0, 200)")
    expect(script).not.toContain("$_.Exception.ToString()")
    expect(script).not.toContain("$_.InvocationInfo")
    expect(script).not.toContain("ProcessId IN")
    expect(script).not.toContain("ExecutionPolicy")
  })

  test("a cold CIM worker gets the startup window; once warm, the steady timeout is enforced", async () => {
    // Cold-start on the Windows release runners is ~15s, three times the 5s
    // steady-state timeout. Judging a never-answered child by the steady
    // timeout kills it mid-warm-up, the retry pays a fresh cold start, and no
    // query ever succeeds — how the release smoke's stop grant kept timing
    // out with {"found":false}.
    const stdout = new PassThrough()
    let kills = 0
    const child = Object.assign(new EventEmitter(), {
      stdin: { writable: true, write: () => true },
      stdout,
      exitCode: null as number | null,
      kill: () => { kills++ },
    })
    const cim = createWindowsCimQuery("reviewed-encoded-command", String.raw`C:\Windows`, 40, 400, () => child)

    // Cold: unanswered for 3x the steady timeout, the query must still be alive.
    let settled = false
    const cold = cim.query([7]).then((rows) => {
      settled = true
      return rows
    })
    await Bun.sleep(120)
    expect(settled).toBe(false)
    stdout.write('{"ok":true,"rows":[{"pid":7}]}\n')
    await expect(cold).resolves.toEqual([{ pid: 7 }])

    // Warm: an unanswered query times out on the steady clock and the hung
    // child is killed so the next query gets a fresh process.
    await expect(cim.query([8])).rejects.toThrow("timed out")
    expect(kills).toBe(1)
    cim.dispose()
  })

  test("surfaces the worker's own failure reason, and stays bounded when it has none", async () => {
    // A bare "response rejected" is what made the Windows release gate
    // undiagnosable: a failing CIM query, a malformed envelope, and an
    // over-long row set all read identically. The worker's reason is the
    // only evidence available on a runner we cannot attach to.
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin: { writable: true, write: () => true },
      stdout,
      exitCode: null as number | null,
      kill: () => {},
    })
    const cim = createWindowsCimQuery("reviewed-encoded-command", String.raw`C:\Windows`, 400, 400, () => child)

    const reported = cim.query([7])
    stdout.write('{"ok":false,"reason":"Access denied to Win32_Process"}\n')
    await expect(reported).rejects.toThrow("rejected: Access denied to Win32_Process")

    const unparsable = cim.query([7])
    stdout.write("not json at all\n")
    await expect(unparsable).rejects.toThrow("unparsable response")

    // No reason field, and a reason too long to pass through whole: neither
    // may widen what crosses the boundary.
    const silent = cim.query([7])
    stdout.write('{"ok":false}\n')
    await expect(silent).rejects.toThrow(/rejected$/)

    const flooded = cim.query([7])
    stdout.write(`${JSON.stringify({ ok: false, reason: "x".repeat(5_000) })}\n`)
    await expect(flooded).rejects.toThrow(new RegExp(`rejected: x{200}$`))
    cim.dispose()
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
