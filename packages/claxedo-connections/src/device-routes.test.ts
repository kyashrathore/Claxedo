import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createIntegrationsRoutes } from "./routes.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"
import type { DevicePoll } from "./types.js"

function harness(polls: DevicePoll[], options: { gateDenies?: boolean } = {}) {
  const registry = createIntegrationRegistry()
  let pollIndex = 0
  registry.register(
    {
      id: "github",
      name: "GitHub",
      methods: ["oauth", "key"],
      capabilities: ["code-host", "work-source"],
      keyTokenType: "bearer",
      prompts: [{ id: "token", label: "Token", secret: true }],
    },
    {
      verify: async () => ({ ok: true, accountLabel: "octocat" }),
      device: {
        start: async () => ({
          deviceCode: "device-abc",
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          intervalMs: 5_000,
          expiresAt: Date.now() + 900_000,
        }),
        poll: async () => polls[Math.min(pollIndex++, polls.length - 1)]!,
      },
    },
  )
  const service = createConnectionsService({
    registry,
    credentials: createMemoryCredentialStore(),
    connections: createMemoryConnectionStore(),
    attempts: createAttempts({ sweepIntervalMs: 0 }),
    newId: () => "connection-1",
  })
  const app = createIntegrationsRoutes(service, {
    ...(options.gateDenies ? { gate: () => new Response("denied", { status: 401 }) } : {}),
  })
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`http://host${path}`, init))
  return { app, service, request }
}

const connect = () =>
  ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "oauth" }),
  }) satisfies RequestInit

describe("device-flow routes", () => {
  test("connect returns the url, the attempt, and the code the user types", async () => {
    const { request, service } = harness([{ status: "pending" }])

    const response = await request("/github/connect", connect())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.url).toBe("https://github.com/login/device")
    expect(body.userCode).toBe("WDJB-MJHT")
    expect(body.attemptId).toBeTruthy()
    expect(body.intervalMs).toBe(5_000)
    service.dispose()
  })

  test("polling the attempt drives the grant to completion", async () => {
    const { request, service } = harness([{ status: "pending" }, {
      status: "complete",
      tokens: { accessToken: "ghu_access", refreshToken: "ghr_refresh" },
    }])
    const { attemptId } = await (await request("/github/connect", connect())).json()

    const first = await request(`/attempts/${attemptId}`)
    expect(first.status).toBe(200)
    expect((await first.json()).status).toBe("pending")

    const second = await request(`/attempts/${attemptId}`)
    expect((await second.json()).status).toBe("complete")

    expect((await service.list()).length).toBe(1)
    service.dispose()
  })

  test("a denied grant reports failed and never leaks the device code", async () => {
    const { request, service } = harness([{ status: "denied" }])
    const { attemptId } = await (await request("/github/connect", connect())).json()

    const response = await request(`/attempts/${attemptId}`)
    const text = await response.text()
    expect(JSON.parse(text).status).toBe("failed")
    expect(text).not.toContain("device-abc")
    expect((await service.list()).length).toBe(0)
    service.dispose()
  })

  test("an expired grant is distinguishable from a refused one", async () => {
    const { request, service } = harness([{ status: "expired" }])
    const { attemptId } = await (await request("/github/connect", connect())).json()

    expect((await (await request(`/attempts/${attemptId}`)).json()).status).toBe("expired")
    service.dispose()
  })

  test("an unknown attempt is a 404, not a poll of someone else's grant", async () => {
    const { request, service } = harness([{ status: "pending" }])
    expect((await request("/attempts/not-a-real-attempt")).status).toBe(404)
    service.dispose()
  })

  test("the attempt route stays behind the gate", async () => {
    const { request, service } = harness([{ status: "pending" }], { gateDenies: true })
    expect((await request("/attempts/anything")).status).toBe(401)
    service.dispose()
  })

  test("the connect response never carries the device code", async () => {
    const { request, service } = harness([{ status: "pending" }])
    const text = await (await request("/github/connect", connect())).text()
    expect(text).not.toContain("device-abc")
    service.dispose()
  })
})
