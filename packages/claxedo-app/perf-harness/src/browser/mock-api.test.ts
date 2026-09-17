import { afterEach, expect, test } from "bun:test"
import type { Page, Route } from "playwright-core"
import { decodeHarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { environmentProfile } from "../environment-profile"
import { seedForScenario } from "../seed"
import type { ScenarioId } from "../types"
import { fixtureFor } from "./fixtures"
import { installMockApi } from "./mock-api"
import { MOCK_STREAM_FIXTURE_HEADER, startMockStreamServer } from "./mock-streams"
import { monitorPage } from "./page-validation"
import { HEAVY_WORKSPACE_FILE_LINES, HEAVY_WORKSPACE_REOPEN_FILE_PATHS } from "./scenarios/heavy-workspace-reopen-contract"

const servers: ReturnType<typeof startMockStreamServer>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop() })

async function transport(scenario: ScenarioId) {
  let handle: (route: Route) => Promise<unknown>
  const listeners = new Map<string, Array<() => void>>()
  const page = {
    on(event: string, listener: () => void) {
      const callbacks = listeners.get(event) ?? []
      callbacks.push(listener)
      listeners.set(event, callbacks)
    },
    async routeWebSocket() {},
    async route(_pattern: string, callback: typeof handle) { handle = callback },
  } as unknown as Page
  const fixture = fixtureFor(scenario, seedForScenario(scenario))
  const monitor = monitorPage(page)
  const streams = startMockStreamServer({ port: 0 })
  servers.push(streams)
  const target = { streams, target: "claxedo" as const, baseUrl: "http://127.0.0.1:47000", mockPort: streams.port, command: "test" }
  await installMockApi(page, target, fixture, monitor, environmentProfile("unthrottled"))
  return {
    fixture,
    monitor,
    streams,
    close(event: "close" | "crash") { for (const listener of listeners.get(event) ?? []) listener() },
    async request(path: string, method = "GET", origin = target.baseUrl, headers: Record<string, string> = {}) {
      let response: { status?: number; contentType?: string; headers?: Record<string, string>; body?: string } | undefined
      let continued: { url: string; headers: Record<string, string> } | undefined
      let fallback = false
      await handle({
        request: () => ({ url: () => `${origin}${path}`, method: () => method, headers: () => ({ origin: target.baseUrl, ...headers }) }),
        fulfill: async (value: NonNullable<typeof response>) => { response = value },
        continue: async (value: NonNullable<typeof continued>) => { continued = value },
        fallback: async () => { fallback = true },
      } as unknown as Route)
      return {
        ...response,
        json: response?.body && response.contentType === "application/json" ? JSON.parse(response.body) : undefined,
        fallback,
        continued,
      }
    },
  }
}

test("registered mock transport serves bounded message pages and rejects conflicting page parameters", async () => {
  const api = await transport("session-switch")
  const id = api.fixture.sessions[0].id
  const surface = await api.request(`/session/${id}/message?view=latest-surface`)
  expect(surface.status).toBe(200)
  expect(surface.json).toHaveLength(2)
  expect(new Headers(surface.headers).get("x-next-cursor")).toBe(surface.json.at(-1).info.id)
  expect(new Headers(surface.headers).get("x-max-event-ordinal")).toBe(String(api.fixture.maxEventOrdinal))
  expect(new Headers(surface.headers).get("access-control-expose-headers")).toContain("x-max-event-ordinal")
  expect(api.fixture.requestCounts.messagesBySession[id]).toBe(1)

  const invalid = await api.request(`/session/${id}/message?view=latest-surface&limit=10`)
  expect(invalid.status).toBe(400)
  expect(invalid.json.error).toContain("view")
  expect(api.monitor.unmatchedMockPaths).toEqual([])

  const oldest = await api.request(`/session/${id}/message?limit=2&before=msg_perf_1`)
  expect(oldest.json).toHaveLength(1)
  expect(new Headers(oldest.headers).get("x-next-cursor")).toBeNull()
  expect(new Headers(oldest.headers).get("x-max-event-ordinal")).toBe(String(api.fixture.maxEventOrdinal))
})

test("registered mock transport counts app reads, excludes preflights, and exposes route drift", async () => {
  const api = await transport("workspace-interactions")
  const preflight = await api.request("/api/wr/diff/vcs?content=summary", "OPTIONS")
  expect(preflight.status).toBe(204)
  expect(api.fixture.requestCounts.stability.vcs).toBe(0)

  const files = await api.request("/api/wr/diff/vcs?content=summary")
  expect(files.status).toBe(200)
  expect(files.json).toHaveLength(api.fixture.changedFiles.length)
  expect(files.json[0].patch).toBeUndefined()
  expect(api.fixture.requestCounts.stability.vcs).toBe(1)

  const missing = await api.request("/api/perf-unregistered-route")
  expect(missing.status).toBe(404)
  expect(api.monitor.unmatchedMockPaths).toEqual(["GET /api/perf-unregistered-route"])
  expect((await api.request("/assets/app.js")).fallback).toBe(true)
  expect((await api.request("/api/unrelated", "GET", "https://example.test")).fallback).toBe(true)
})

test("fixture accounting remains isolated across independently registered pages", async () => {
  const first = await transport("session-switch")
  const second = await transport("session-switch")
  await first.request(`/session/${first.fixture.sessions[0].id}/message?limit=2`)
  expect(first.fixture.requestCounts.messages).toBe(1)
  expect(second.fixture.requestCounts.messages).toBe(0)
  expect(second.monitor.unmatchedMockPaths).toEqual([])
})

test("connection discovery decodes through the product contract without triggering error retries", async () => {
  const api = await transport("workspace-interactions")
  const response = await api.request("/api/claxedo/agent-config/connections")
  expect(response.status).toBe(200)
  expect(decodeHarnessConnectionsCatalog(response.json)).toEqual({ status: "supported", connections: [] })
  expect((await api.request("/api/claxedo/agent-config/connections", "POST")).status).toBe(404)
})

test("activation auxiliary reads expose the fixture's goal and device state without session events", async () => {
  const api = await transport("launch-project")
  const goal = await api.request(`/session/${api.fixture.sessions[0].id}/goal/state`)
  expect(goal.status).toBe(200)
  expect(goal.json).toEqual(api.fixture.goalState)
  expect(goal.json.capabilities).toMatchObject({
    implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [],
  })
  expect(goal.json.capabilities.unavailableReason).toBeString()
  expect((await api.request("/api/claxedo/remote-access/devices")).json).toEqual({ devices: [] })

  expect(api.fixture.requestCounts.messages).toBe(0)
  expect(api.monitor.unmatchedMockPaths).toEqual([])
})

test("mock preflights stay local while SSE continues through the private page lease and closes with the page", async () => {
  for (const event of ["close", "crash"] as const) {
    const api = await transport("launch-project")
    const path = `/api/wr/events?directory=${encodeURIComponent(api.fixture.directory)}`
    const preflight = await api.request(path, "OPTIONS", undefined, {
      "access-control-request-headers": "authorization, last-event-id",
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers?.["access-control-allow-headers"]).toContain("last-event-id")
    expect(preflight.continued).toBeUndefined()
    expect(api.fixture.requestCounts.stability.sse).toBe(0)
    const routed = await api.request(path, "GET", undefined, {
      "last-event-id": "17",
      [MOCK_STREAM_FIXTURE_HEADER]: "page-supplied-value",
    })
    expect(routed.status).toBeUndefined()
    expect(routed.continued?.url).toBe(`${api.streams.origin}${path}`)
    expect(routed.continued?.headers[MOCK_STREAM_FIXTURE_HEADER]).not.toBe("page-supplied-value")
    const response = await fetch(routed.continued!.url, { headers: routed.continued!.headers })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:47000")
    const reader = response.body!.getReader()
    const body = new TextDecoder().decode((await reader.read()).value)
    expect(body.split("\n")[0]).toBe("id: 17")
    const frame = JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6))
    expect(frame).toEqual({ type: "heartbeat" })
    expect(api.streams.activeConnections).toBe(1)
    expect(api.fixture.requestCounts.stability.sse).toBe(1)
    expect(api.fixture.requestCounts.messages).toBe(0)
    expect(api.monitor.unmatchedMockPaths).toEqual([])
    api.close(event)
    expect(api.streams.activeConnections).toBe(0)
    expect((await reader.read()).done).toBe(true)
    expect((await fetch(routed.continued!.url, { headers: routed.continued!.headers })).status).toBe(403)
  }
})

test("both runtime file mounts serve the same substantial workspace corpus and account for each read", async () => {
  const api = await transport("heavy-workspace-reopen")
  const directory = encodeURIComponent(api.fixture.directory)
  const filePath = HEAVY_WORKSPACE_REOPEN_FILE_PATHS[0]
  for (const prefix of ["", "/api/wr"]) {
    const root = await api.request(`${prefix}/file?directory=${directory}&path=`)
    expect(root.status).toBe(200)
    expect(root.json).toEqual([{
      name: "src", path: "src", absolute: `${api.fixture.directory}/src`, type: "directory", ignored: false,
    }])
    const files = await api.request(`${prefix}/file?directory=${directory}&path=src/generated`)
    expect(files.status).toBe(200)
    expect(files.json).toHaveLength(api.fixture.changedFiles.length)
    expect(files.json.find((file: { path: string }) => file.path === filePath)).toMatchObject({
      absolute: `${api.fixture.directory}/${filePath}`, type: "file", ignored: false,
    })
    const search = await api.request(`${prefix}/find/file?directory=${directory}&query=${encodeURIComponent(filePath)}&dirs=false`)
    expect(search.status).toBe(200)
    expect(search.json).toEqual([filePath])
    const content = await api.request(`${prefix}/file/content?directory=${directory}&path=${encodeURIComponent(filePath)}`)
    expect(content.status).toBe(200)
    expect(content.json.type).toBe("text")
    expect(content.json.content.split("\n")).toHaveLength(HEAVY_WORKSPACE_FILE_LINES + 1)
    const status = await api.request(`${prefix}/file/status?directory=${directory}`)
    expect(status.status).toBe(200)
    expect(status.json[0]).toEqual({
      path: api.fixture.changedFiles[0].file,
      added: api.fixture.changedFiles[0].additions,
      removed: api.fixture.changedFiles[0].deletions,
      status: api.fixture.changedFiles[0].status,
    })
    const all = await api.request(`${prefix}/file/all?directory=${directory}`)
    expect(all.json).toEqual({ paths: api.fixture.changedFiles.map((file) => file.file) })
  }
  expect(api.fixture.requestCounts.stability.file).toBe(12)
  expect(api.monitor.unmatchedMockPaths).toEqual([])

  for (const prefix of ["", "/api/wr"]) {
    expect((await api.request(`${prefix}/file/not-registered`)).status).toBe(404)
    expect((await api.request(`${prefix}/file`, "POST")).status).toBe(404)
  }
})
