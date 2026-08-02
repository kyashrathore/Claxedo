import { describe, expect, test } from "bun:test"

import { createWslSource, mapWslSnapshot } from "./wsl-source"

describe("WSL diagnostics source", () => {
  test("disabled WSL is explicitly not applicable and never collects", () => {
    let calls = 0
    const source = createWslSource({
      enabled: false,
      collect: async () => {
        calls++
        return []
      },
    })
    source.registerRoot({
      handshakeId: "handshake",
      pid: 10,
      startTicks: "100",
      ownerId: "owner-wsl",
      label: "WSL runtime",
      launchId: "launch",
    })
    source.requestCollection(0)
    expect(calls).toBe(0)
    expect(source.statuses()[0]).toMatchObject({ source: "wsl", state: "unsupported" })
  })

  test("requires an enabled root handshake and isolates collection failure", async () => {
    let reject = false
    const source = createWslSource({
      enabled: true,
      collect: async (roots) => {
        if (reject) throw new Error("secret WSL failure")
        return [{ pid: roots[0]!.pid, ppid: 1, rootPid: roots[0]!.pid, startTicks: "100", rssBytes: 8_192 }]
      },
    })
    source.requestCollection(0)
    expect(source.statuses()[0]).toMatchObject({ state: "warming-up" })
    source.registerRoot({
      handshakeId: "handshake",
      pid: 10,
      startTicks: "100",
      ownerId: "owner-wsl",
      label: "WSL runtime",
      launchId: "launch",
    })
    source.requestCollection(1)
    await Promise.resolve()
    expect(source.drain(2)[0]).toMatchObject({
      process: { identity: { domain: "wsl", pid: 10 } },
      point: { rssBytes: { state: "available", value: 8_192 } },
    })
    reject = true
    source.requestCollection(3)
    await Bun.sleep(0)
    expect(source.statuses()[0]).toMatchObject({ state: "degraded", reason: "source-failed" })
    expect(JSON.stringify(source.statuses())).not.toContain("secret WSL failure")
  })

  test("ignores every late result after disposal", async () => {
    let resolve: ((value: never[]) => void) | undefined
    const source = createWslSource({
      enabled: true,
      collect: () => new Promise((done) => (resolve = done)),
    })
    source.registerRoot({
      handshakeId: "handshake",
      pid: 10,
      startTicks: "100",
      ownerId: "owner-wsl",
      label: "WSL runtime",
      launchId: "launch",
    })
    source.requestCollection(1)
    source.dispose()
    resolve?.([])
    await Promise.resolve()
    expect(source.drain(2)).toEqual([])
  })

  test("production collector discovers descendants and binds them to the handshake identity", async () => {
    const source = await Bun.file(new URL("./wsl-source.ts", import.meta.url)).text()
    expect(source).toContain("/proc/$p/task/$p/children")
    expect(source).not.toContain("ps -eo pid=,ppid=")
    expect(source).toContain("getconf CLK_TCK")
    expect(source).toContain("byPid.get(root.pid)?.startTicks !== root.startTicks")
    expect(source).toContain("byParent.get(pid)")
    const root = {
      handshakeId: "handshake",
      pid: 10,
      startTicks: "100",
      ownerId: "owner-wsl",
      label: "WSL runtime",
      launchId: "launch",
    }
    const fixture = ["10 1 100 20 2 4096 250", "11 10 101 10 1 4096 250", "12 99 102 10 1 4096 250"].join("\n")
    expect(mapWslSnapshot(fixture, [root], 0, 4).map((sample) => sample.pid)).toEqual([10, 11])
    expect(mapWslSnapshot(fixture, [{ ...root, startTicks: "999" }], 0, 4)).toEqual([])
  })

  test("successful reconciliation forgets exited WSL descendants", async () => {
    let includeChild = true
    const source = createWslSource({
      enabled: true,
      collect: async () => [
        { pid: 10, ppid: 1, rootPid: 10, startTicks: "100" },
        ...(includeChild ? [{ pid: 11, ppid: 10, rootPid: 10, startTicks: "101" }] : []),
      ],
    })
    source.registerRoot({
      handshakeId: "handshake",
      pid: 10,
      startTicks: "100",
      ownerId: "owner-wsl",
      label: "WSL runtime",
      launchId: "launch",
    })
    source.requestCollection(1)
    await Promise.resolve()
    expect(source.drain(1).map((observation) => observation.process.identity.pid)).toEqual([10, 11])

    includeChild = false
    source.requestCollection(2)
    await Promise.resolve()
    expect(source.drain(2).map((observation) => observation.process.identity.pid)).toEqual([10])
  })
})
