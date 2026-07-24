import { describe, expect, test } from "bun:test"

import { createElectronSource } from "./electron-source"

const metric = (
  pid: number,
  creationTime: number,
  type: "Browser" | "Tab" | "Utility" | "GPU",
  cpu = 1,
  rssKiB = 100,
) => ({
  pid,
  creationTime,
  type,
  cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
  memory: { workingSetSize: rssKiB, peakWorkingSetSize: rssKiB },
})

describe("Electron diagnostics source", () => {
  test("samples main before readiness, then maps windows and retains unmapped Electron buckets", async () => {
    let ready = false
    const source = createElectronSource({
      process: {
        pid: 10,
        getCreationTime: () => 1_000,
        getCPUUsage: () => ({ percentCPUUsage: 3, idleWakeupsPerSecond: 0 }),
        memoryUsage: () => ({ rss: 2_000 }),
      },
      isReady: () => ready,
      getAppMetrics: () => [
        metric(10, 1_000, "Browser", 4, 3),
        metric(20, 2_000, "Tab", 5, 4),
        metric(30, 3_000, "GPU", 6, 5),
        { ...metric(40, 4_000, "Utility", 7, 6), name: "Network Service" },
      ],
      getWindows: () => [
        {
          id: 7,
          isDestroyed: () => false,
          webContents: { id: 70, getOSProcessId: () => 20 },
        },
      ],
    })

    const beforeReady = await source.collect(10)
    expect(beforeReady.map((item) => item.process.role)).toEqual(["main"])
    expect(beforeReady[0]?.point.rssBytes).toEqual({ state: "available", value: 2_000 })

    ready = true
    const afterReady = await source.collect(20)
    expect(afterReady.map((item) => [item.process.identity.pid, item.process.role, item.process.label])).toEqual([
      [10, "main", "Claxedo main"],
      [20, "renderer", "Claxedo window 7"],
      [30, "gpu", "Electron GPU"],
      [40, "utility", "Network Service"],
    ])
    expect(afterReady.find((item) => item.process.identity.pid === 10)?.point).toMatchObject({
      cpuMachinePercent: { state: "available", value: 4 },
      rssBytes: { state: "available", value: 3 * 1_024 },
    })
  })

  test("keeps a registered server utility in its own owner and series", async () => {
    const source = createElectronSource({
      process: {
        pid: 10,
        getCreationTime: () => 1_000,
        getCPUUsage: () => ({ percentCPUUsage: 1, idleWakeupsPerSecond: 0 }),
        memoryUsage: () => ({ rss: 2_000 }),
      },
      isReady: () => true,
      getAppMetrics: () => [
        metric(10, 1_000, "Browser"),
        { ...metric(50, 5_000, "Utility", 19, 512), name: "Claxedo Server" },
      ],
      getWindows: () => [],
    })
    source.registerRoot({
      pid: 50,
      launchId: "server-launch",
      ownerId: "owner-server",
      ownerKind: "server",
      role: "server",
      label: "Claxedo server",
    })

    const result = await source.collect(100)
    const server = result.find((item) => item.process.role === "server")
    expect(server?.owner).toMatchObject({ id: "owner-server", kind: "server", launchId: "server-launch" })
    expect(server?.process.identity).toMatchObject({ pid: 50, launchId: "server-launch" })
    expect(server?.point.cpuMachinePercent).toEqual({ state: "available", value: 19 })
  })

  test("uses creation identity to separate a reused renderer PID", async () => {
    let creationTime = 2_000
    const source = createElectronSource({
      process: {
        pid: 10,
        getCreationTime: () => 1_000,
        getCPUUsage: () => ({ percentCPUUsage: 1, idleWakeupsPerSecond: 0 }),
        memoryUsage: () => ({ rss: 2_000 }),
      },
      isReady: () => true,
      getAppMetrics: () => [metric(20, creationTime, "Tab")],
      getWindows: () => [
        {
          id: 7,
          isDestroyed: () => false,
          webContents: { id: 70, getOSProcessId: () => 20 },
        },
      ],
    })

    const first = await source.collect(100)
    creationTime = 3_000
    const second = await source.collect(200)
    expect(first.find((item) => item.process.identity.pid === 20)?.process.identity.id).not.toBe(
      second.find((item) => item.process.identity.pid === 20)?.process.identity.id,
    )
  })
})
