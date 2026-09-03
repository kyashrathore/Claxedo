import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { noConnectionReuseFetch } from "./no-reuse-fetch"

let server: Server
let origin: string
const sockets = new Set<unknown>()
let received: Array<{ method: string; url: string; body: string; connection: string | undefined }> = []

beforeAll(async () => {
  server = createServer((request, response) => {
    sockets.add(request.socket)
    let body = ""
    request.on("data", (chunk) => (body += String(chunk)))
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
        connection: request.headers.connection,
      })
      if (request.url === "/no-content") {
        response.writeHead(204).end()
        return
      }
      if (request.url === "/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write("data: one\n\n")
        response.write("data: two\n\n")
        response.end()
        return
      }
      if (request.url === "/never") return
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ echo: body }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections?.()
  server.close()
})

describe("noConnectionReuseFetch", () => {
  test("delivers bodies and uses a distinct, closing connection per request", async () => {
    received = []
    sockets.clear()
    const first = await noConnectionReuseFetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=abc",
    })
    const second = await noConnectionReuseFetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token",
    })
    expect(await first.json()).toEqual({ echo: "grant_type=authorization_code&code=abc" })
    expect(await second.json()).toEqual({ echo: "grant_type=refresh_token" })
    // One socket per request, and each announces closure — never keep-alive.
    expect(sockets.size).toBe(2)
    expect(received.map((entry) => entry.connection)).toEqual(["close", "close"])
  })

  test("streams a response body incrementally", async () => {
    const response = await noConnectionReuseFetch(`${origin}/stream`, { method: "GET" })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe("data: one\n\ndata: two\n\n")
  })

  test("returns a bodyless Response for 204", async () => {
    const response = await noConnectionReuseFetch(`${origin}/no-content`, { method: "GET" })
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  test("aborts through the request signal", async () => {
    const controller = new AbortController()
    const pending = noConnectionReuseFetch(`${origin}/never`, { method: "GET", signal: controller.signal })
    controller.abort(new Error("stall guard"))
    await expect(pending).rejects.toThrow()
  })
})
