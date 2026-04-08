import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { findNextPort, tryPort } from "./portpick"

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

  test("finds the next port when the preferred port is occupied", async () => {
    const srv = await listen()
    const addr = srv.address()
    if (!addr || typeof addr === "string") throw new Error("missing server address")

    try {
      expect(await findNextPort(addr.port)).toBe(addr.port + 1)
    } finally {
      await close(srv)
    }
  })

  test("skips multiple occupied ports when scanning upward", async () => {
    const first = await listen()
    const one = first.address()
    if (!one || typeof one === "string") throw new Error("missing server address")
    const second = await new Promise<Server>((resolve, reject) => {
      const srv = createServer()
      srv.on("error", reject)
      srv.listen({ host: "127.0.0.1", port: one.port + 1 }, () => resolve(srv))
    })

    try {
      expect(await findNextPort(one.port)).toBe(one.port + 2)
    } finally {
      await close(second)
      await close(first)
    }
  })
})
