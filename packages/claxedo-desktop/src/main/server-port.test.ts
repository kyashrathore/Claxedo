import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { DEFAULT_CLAXEDO_SERVER_PORT, findFreePort, resolveBaseServerPort, type Probe } from "./server-port"

/**
 * A probe standing in for the OS bind: every port in `taken` reports EADDRINUSE
 * the way a real occupied port does, so the scan is exercised without racing
 * whatever else is listening on the machine running the test.
 */
function probeWith(taken: ReadonlySet<number>, seen?: number[]): Probe {
  return (port) => {
    seen?.push(port)
    if (taken.has(port)) {
      const error: NodeJS.ErrnoException = new Error("listen EADDRINUSE")
      error.code = "EADDRINUSE"
      return Promise.reject(error)
    }
    return Promise.resolve(port)
  }
}

describe("DEFAULT_CLAXEDO_SERVER_PORT", () => {
  test("is 2593 and never 3001", () => {
    expect(DEFAULT_CLAXEDO_SERVER_PORT).toBe(2593)
    // 3001 is a default shared with too much other dev tooling: losing the bind
    // race is the mild failure, the development attach probe adopting a
    // stranger's server as ours is the bad one.
    expect(DEFAULT_CLAXEDO_SERVER_PORT).not.toBe(3001)
  })

  test("matches claxedo-server's standalone default", () => {
    // The desktop app cannot import @claxedo/server (the server ships as a
    // separately bundled utility process, not a dependency), so the constant is
    // declared twice. If the two drift, the development attach probe checks one
    // port while `claxedo-server dev` listens on another and every `bun dev`
    // quietly gets a second embedded server. Read the source rather than trust
    // the comments to stay honest.
    const source = readFileSync(
      join(import.meta.dir, "../../../claxedo-server/src/deployments/local/port.ts"),
      "utf8",
    )
    const declared = /export const DEFAULT_CLAXEDO_SERVER_PORT = (\d+)/.exec(source)
    expect(declared).not.toBeNull()
    expect(Number(declared?.[1])).toBe(DEFAULT_CLAXEDO_SERVER_PORT)
  })
})

describe("resolveBaseServerPort", () => {
  test("uses the default when CLAXEDO_SERVER_PORT is unset or blank", () => {
    expect(resolveBaseServerPort({})).toBe(DEFAULT_CLAXEDO_SERVER_PORT)
    expect(resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "   " })).toBe(DEFAULT_CLAXEDO_SERVER_PORT)
  })

  test("honours an explicit override", () => {
    expect(resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "4100" })).toBe(4100)
    expect(resolveBaseServerPort({ CLAXEDO_SERVER_PORT: " 4100 " })).toBe(4100)
    expect(resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "0" })).toBe(0)
  })

  test("rejects a value that is not a port", () => {
    // Silently falling back to the default here would strand the caller on a
    // port they did not ask for, which is exactly the confusion this change is
    // meant to remove.
    expect(() => resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "not-a-port" })).toThrow("CLAXEDO_SERVER_PORT")
    expect(() => resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "70000" })).toThrow("CLAXEDO_SERVER_PORT")
    expect(() => resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "-1" })).toThrow("CLAXEDO_SERVER_PORT")
    expect(() => resolveBaseServerPort({ CLAXEDO_SERVER_PORT: "80.5" })).toThrow("CLAXEDO_SERVER_PORT")
  })
})

describe("findFreePort", () => {
  test("takes the base port when it is free", async () => {
    const seen: number[] = []
    expect(await findFreePort(2593, { probe: probeWith(new Set(), seen) })).toBe(2593)
    expect(seen).toEqual([2593])
  })

  test("walks up one port at a time instead of jumping to an ephemeral port", async () => {
    const seen: number[] = []
    const port = await findFreePort(2593, { probe: probeWith(new Set([2593, 2594, 2595]), seen) })
    // The old behaviour was `listen(0)` on the first EADDRINUSE, which would
    // land somewhere above 32768 — assert the exact next free port so a
    // regression to the random fallback cannot pass.
    expect(port).toBe(2596)
    expect(seen).toEqual([2593, 2594, 2595, 2596])
  })

  test("treats EACCES as occupied and keeps walking", async () => {
    const eacces: Probe = (port) => {
      if (port !== 2594) {
        const error: NodeJS.ErrnoException = new Error("listen EACCES")
        error.code = "EACCES"
        return Promise.reject(error)
      }
      return Promise.resolve(port)
    }
    expect(await findFreePort(2593, { probe: eacces })).toBe(2594)
  })

  test("gives up with an actionable error once the window is exhausted", async () => {
    const taken = new Set(Array.from({ length: 64 }, (_, index) => 2593 + index))
    await expect(findFreePort(2593, { probe: probeWith(taken) })).rejects.toThrow("CLAXEDO_SERVER_PORT")
  })

  test("stops at the top of the port range rather than probing past 65535", async () => {
    const seen: number[] = []
    await expect(findFreePort(65534, { probe: probeWith(new Set([65534, 65535]), seen) })).rejects.toThrow(
      "No free port found",
    )
    expect(seen).toEqual([65534, 65535])
  })

  test("honours port 0 as the explicit any-port request", async () => {
    const seen: number[] = []
    expect(await findFreePort(0, { probe: probeWith(new Set(), seen) })).toBe(0)
    expect(seen).toEqual([0])
  })

  test("surfaces a non-bind error instead of walking past it", async () => {
    const broken: Probe = () => Promise.reject(new Error("socket layer is down"))
    await expect(findFreePort(2593, { probe: broken })).rejects.toThrow("socket layer is down")
  })

  test("binds a real port and releases it for the caller", async () => {
    // The default probe has to actually free the port it tested, or the server
    // it was chosen for cannot bind it.
    const port = await findFreePort(DEFAULT_CLAXEDO_SERVER_PORT)
    expect(port).toBeGreaterThanOrEqual(DEFAULT_CLAXEDO_SERVER_PORT)
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()))
    })
  })
})
