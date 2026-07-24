import { describe, expect, test } from "bun:test"

import {
  linuxCreationIdentity,
  parseLinuxStartTicks,
  parseWindowsCimRow,
  probeProcessCreationIdentity,
  sameCreationIdentity,
  windowsCpuMachinePercent,
} from "./process-identity"

describe("process identity", () => {
  test("parses Linux start ticks even when comm contains spaces and parentheses", () => {
    const stat = "42 (agent (worker)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21"
    expect(parseLinuxStartTicks(stat)).toBe("987654")
    expect(linuxCreationIdentity(stat)).toEqual({
      state: "available",
      value: "987654",
      source: "linux-proc",
    })
  })

  test("retains Windows 64-bit RSS and computes machine-share CPU after warmup", () => {
    const previous = parseWindowsCimRow({
      pid: 4,
      ppid: 0,
      creationTicks: "133700000000000000",
      kernelTicks: "10000000",
      userTicks: "10000000",
      rssBytes: "8589934592",
    })
    const current = parseWindowsCimRow({
      pid: 4,
      ppid: 0,
      creationTicks: "133700000000000000",
      kernelTicks: "30000000",
      userTicks: "30000000",
      rssBytes: "8589934592",
    })
    expect(current?.rssBytes).toBe(8_589_934_592n)
    expect(windowsCpuMachinePercent({ previous, current: current!, elapsedMs: 1_000, logicalProcessors: 8 })).toEqual({
      state: "available",
      value: 50,
    })
  })

  test("PID reuse and invalid decimal values fail closed", () => {
    expect(
      sameCreationIdentity(
        { state: "available", value: "1", source: "windows-cim" },
        { state: "available", value: "2", source: "windows-cim" },
      ),
    ).toBe(false)
    expect(
      parseWindowsCimRow({
        pid: 1,
        ppid: 0,
        creationTicks: "1",
        kernelTicks: "2",
        userTicks: "3",
        rssBytes: "-1",
      }),
    ).toBeUndefined()
  })

  test("uses exact Electron, Linux, and Windows probes while Darwin remains read-only", async () => {
    expect(
      await probeProcessCreationIdentity({
        platform: "darwin",
        pid: 10,
        electronMetrics: () => [{ pid: 10, creationTime: 1234 }],
      }),
    ).toEqual({ state: "available", value: "1234", source: "electron" })
    expect(
      await probeProcessCreationIdentity({
        platform: "linux",
        pid: 10,
        readLinuxStat: async () => "10 (worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 999 20",
      }),
    ).toEqual({ state: "available", value: "999", source: "linux-proc" })
    expect(
      await probeProcessCreationIdentity({
        platform: "win32",
        pid: 10,
        queryWindows: async () => [
          { pid: 10, ppid: 1, creationTicks: "777", kernelTicks: "1", userTicks: "2", rssBytes: "3" },
        ],
      }),
    ).toEqual({ state: "available", value: "777", source: "windows-cim" })
    expect(await probeProcessCreationIdentity({ platform: "darwin", pid: 99 })).toEqual({
      state: "unavailable",
      reason: "identity-unavailable",
    })
  })
})
