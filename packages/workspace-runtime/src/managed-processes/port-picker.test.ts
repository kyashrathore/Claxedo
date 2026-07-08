import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { tryPort } from "./port-picker"

function listen() {
  return new Promise<Server>((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen({ host: "127.0.0.1", port: 0 }, () => resolve(srv))
  })
}

function close(srv: Server) {
  return new Promise<void>((resolve, reject) => {
    srv.close((err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

describe("process port probe", () => {
  test("treats a localhost listener as occupied", async () => {
    const srv = await listen()
    const addr = srv.address()
    if (!addr || typeof addr === "string") throw new Error("missing server address")

    try {
      expect(await tryPort(addr.port)).toBe(false)
    } finally {
      await close(srv)
    }
  })

  test("treats a released port as free", async () => {
    const srv = await listen()
    const addr = srv.address()
    if (!addr || typeof addr === "string") throw new Error("missing server address")
    const port = addr.port
    await close(srv)

    expect(await tryPort(port)).toBe(true)
  })
})
