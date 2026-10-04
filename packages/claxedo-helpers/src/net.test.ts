import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { freePort } from "./net"

describe("freePort", () => {
  test("returns an ephemeral port that is then bindable", async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65_536)
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", resolve)
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("a concrete port is asserted bindable and returned unchanged", async () => {
    const port = await freePort()
    expect(await freePort(port)).toBe(port)
  })

  test("rejects when the requested port is already taken", async () => {
    const server = createServer()
    const port = await freePort()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", resolve)
    })
    try {
      // The message wording differs between Node and Bun; the errno does not.
      await expect(freePort(port)).rejects.toMatchObject({ code: "EADDRINUSE" })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
