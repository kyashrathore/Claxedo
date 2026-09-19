import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Context } from "hono"
import { Hono } from "hono"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { embeddedConfigModeForPath } from "./internals"
import { createWorkspaceRuntimeProxy } from "./middleware"
import { EMBEDDED_RELAY_HOST_AUTH_HEADER } from "./embedded-relay-host-auth"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"

describe("embedded workspace runtime configuration boundary", () => {
  test("read-only workspace APIs remain available when configuration needs attention", () => {
    expect(embeddedConfigModeForPath("/session", "GET")).toBe("skip")
    expect(embeddedConfigModeForPath("/permission/modes", "GET")).toBe("skip")
    expect(embeddedConfigModeForPath("/session/s1/message", "GET")).toBe("skip")
  })

  test("session mutations still fail closed on configuration replay", () => {
    expect(embeddedConfigModeForPath("/session", "POST")).toBe("sync")
    expect(embeddedConfigModeForPath("/session/s1/message", "POST")).toBe("sync")
  })

  test("transport and filesystem paths never replay configuration", () => {
    expect(embeddedConfigModeForPath("/api/wr/events", "POST")).toBe("skip")
    expect(embeddedConfigModeForPath("/file", "POST")).toBe("skip")
  })
})

describe("the host aggregate's place in runtime dispatch", () => {
  const previousDataDir = process.env.CLAXEDO_DATA_DIR
  let dataRoot: string

  // The workspace-scoped cases fall through to `resolveWorkspace`, which boots
  // the workspace store; it must not write into the developer's own data dir.
  beforeAll(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-dispatch-aggregate-"))
    process.env.CLAXEDO_DATA_DIR = dataRoot
  })

  afterAll(async () => {
    ClaxedoDB.close()
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    await fs.rm(dataRoot, { recursive: true, force: true })
  })

  function dispatcher(input: { aggregate?: boolean; requireRelayActor?: boolean } = {}) {
    const served: Context[] = []
    const app = new Hono()
      .use(createWorkspaceRuntimeProxy({
        ...(input.aggregate === false ? {} : {
          hostEventStream: (c: Context) => {
            served.push(c)
            return new Response("aggregate")
          },
        }),
        ...(input.requireRelayActor ? { requireRelayActor: true } : {}),
      }))
      .all("*", (c) => c.text("fell through", 404))
    return { app, served }
  }

  test("a loopback-direct wr/events naming no workspace is answered by the aggregate", async () => {
    const { app, served } = dispatcher()
    const response = await app.request("http://127.0.0.1/api/wr/events")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("aggregate")
    expect(served).toHaveLength(1)
  })

  test.each([
    ["a directory query", "http://127.0.0.1/api/wr/events?directory=%2Frepo%2Fone", {}],
    ["a workspaceId query", "http://127.0.0.1/api/wr/events?workspaceId=ws_1", {}],
    ["a workspace query", "http://127.0.0.1/api/wr/events?workspace=ws_1", {}],
    ["a directory header", "http://127.0.0.1/api/wr/events", { "x-claxedo-directory": "/repo/one" }],
    ["a workspace header", "http://127.0.0.1/api/wr/events", { "x-workspace-id": "ws_1" }],
  ])("wr/events named by %s stays on the workspace dispatch path", async (_name, url, headers) => {
    const { app, served } = dispatcher()
    const response = await app.request(url, { headers })
    expect(served).toHaveLength(0)
    // No such workspace here, so dispatch passes the request on exactly as it
    // does for any other unresolvable workspace.
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("fell through")
  })

  test("another runtime-owned path naming no workspace is unchanged by the aggregate", async () => {
    const withAggregate = dispatcher()
    const without = dispatcher({ aggregate: false })
    const served = await withAggregate.app.request("http://127.0.0.1/api/wr/health")
    const bare = await without.app.request("http://127.0.0.1/api/wr/health")
    expect(withAggregate.served).toHaveLength(0)
    expect(served.status).toBe(bare.status)
    expect(await served.text()).toBe(await bare.text())
    expect(bare.status).toBe(404)
  })

  test("a composition that mounts no aggregate leaves wr/events where it was", async () => {
    const { app } = dispatcher({ aggregate: false })
    const response = await app.request("http://127.0.0.1/api/wr/events")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("fell through")
  })

  test("a session-scoped request is refused: the aggregate spans workspaces", async () => {
    const { app, served } = dispatcher()
    const response = await app.request("http://127.0.0.1/api/wr/events?sessionID=ses-1")
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("host_event_stream_session_scoped")
    expect(served).toHaveLength(0)
  })

  test.each([
    ["a forwarded client header", "http://127.0.0.1/api/wr/events", { "x-forwarded-for": "203.0.113.9" }],
    ["a host that is not loopback", "http://192.168.1.20/api/wr/events", {}],
    ["a foreign origin", "http://127.0.0.1/api/wr/events", { origin: "https://claxedo.example" }],
    ["the relay host-auth stamp", "http://127.0.0.1/api/wr/events", { [EMBEDDED_RELAY_HOST_AUTH_HEADER]: JSON.stringify({ actor_id: "actor_1" }) }],
    // The tunnel replays onto this same listener with the proxy headers gone,
    // so the relay's own marker is the only thing on such a request that the
    // three cases above would not see.
    ["the relay's forwarding marker", "http://127.0.0.1/api/wr/events", { "x-forwarded-by": "workspace-relay" }],
  ])("wr/events carrying %s is refused: only a loopback-direct reader is the machine's own user", async (_name, url, headers) => {
    const { app, served } = dispatcher()
    const response = await app.request(url, { headers })
    expect(response.status).toBe(403)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("host_event_stream_denied")
    expect(served).toHaveLength(0)
  })

  test("an unauthorized reader is refused before its request is read for shape", async () => {
    const { app, served } = dispatcher()
    const response = await app.request("http://127.0.0.1/api/wr/events?sessionID=ses-1", {
      headers: { [EMBEDDED_RELAY_HOST_AUTH_HEADER]: JSON.stringify({ actor_id: "actor_1" }) },
    })
    expect(response.status).toBe(403)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("host_event_stream_denied")
    expect(served).toHaveLength(0)
  })

  test("a deployment that requires a verified relay actor serves no aggregate at all", async () => {
    const { app, served } = dispatcher({ requireRelayActor: true })
    const response = await app.request("http://127.0.0.1/api/wr/events")
    expect(response.status).toBe(403)
    expect((await response.json() as { error: { code: string } }).error.code).toBe("host_event_stream_denied")
    expect(served).toHaveLength(0)
  })
})
