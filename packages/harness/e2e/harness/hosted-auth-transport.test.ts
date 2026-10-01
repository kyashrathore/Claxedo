import { afterAll, expect, mock, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import { hostedFetch } from "./hosted-auth"
import type { startHostedStack } from "./hosted-stack"

const https = { ...await import("node:https") }
const launches: Array<{ options: Record<string, unknown>; body?: string }> = []
afterAll(() => mock.module("node:https", () => https))
mock.module("node:https", () => ({ ...https, request: (_url: URL, options: Record<string, unknown>, callback: (response: unknown) => void) => {
  const launch: { options: Record<string, unknown>; body?: string } = { options }
  launches.push(launch)
  return Object.assign(new EventEmitter(), { end(body?: string) {
    launch.body = body
    const response = Object.assign(new EventEmitter(), { statusCode: 200, rawHeaders: ["content-type", "application/json"] })
    callback(response)
    queueMicrotask(() => { response.emit("data", Buffer.from("{}")); response.emit("end") })
  } })
} }))

test("hosted HTTPS requests use the fixture CA on Node and carry only the selected account cookie", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}))
  try {
    const stack = { workerUrl: "https://127.0.0.1:42001", certificate: "/dev/null" } as Awaited<ReturnType<typeof startHostedStack>>
    const response = await hostedFetch(stack, "/api/control/session-registrations/reserve", { method: "POST", body: "{}" }, { id: "owner", cookie: "owner-cookie" })
    expect(response.status).toBe(200)
    expect(launches).toHaveLength(1)
    expect(launches[0].options.ca).toBe("")
    expect(launches[0].options.headers).toMatchObject({ cookie: "owner-cookie", origin: stack.workerUrl })
    expect(launches[0].body).toBe("{}")
    expect(fetch).not.toHaveBeenCalled()
  } finally { fetch.mockRestore() }
})
