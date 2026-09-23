import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { createSocket } from "node:dgram"
import { connect, createServer, type Server } from "node:net"
import { findPidOnPort, tryPort } from "./port-picker"

function listen(port = 0) {
  return new Promise<Server>((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen({ host: "127.0.0.1", port }, () => resolve(srv))
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

async function udpOnlyPort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const udp = createSocket("udp4")
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject)
      udp.bind(0, "127.0.0.1", () => resolve())
    })
    const port = udp.address().port
    const tcp = await listen(port).catch(() => undefined)
    if (tcp) {
      await close(tcp)
      return { port, udp }
    }
    udp.close()
  }
  throw new Error("no UDP port was also free over TCP")
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

  test("treats a port used only over UDP as free", async () => {
    // Browsers hold QUIC sockets on ephemeral UDP ports, the same numbers the
    // OS hands out for TCP.
    const { port, udp } = await udpOnlyPort()

    try {
      expect(await tryPort(port)).toBe(true)
    } finally {
      udp.close()
    }
  })
})

describe("port occupier lookup", () => {
  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL")
  })

  test.skipIf(process.platform === "win32")("names the listener, not a process connected to it", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "const s=require('node:net').createServer(()=>{}); s.listen(0,'127.0.0.1',()=>console.log(s.address().port)); setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    children.push(child)
    const port = Number(await new Promise<string>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim()))
    }))
    const client = connect(port, "127.0.0.1")
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve)
      client.once("error", reject)
    })

    try {
      expect(await findPidOnPort(port)).toBe(child.pid)
    } finally {
      client.destroy()
    }
  }, 20_000)
})
