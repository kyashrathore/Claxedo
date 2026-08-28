import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../runtime-event-hub"
import { runtimeEventsHandler } from "./events"
import { createWorkspaceHost } from "../workspace"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import type { SessionAccessPolicy } from "../session-access-policy"

const event = (sessionId: string, delta: string): Omit<RuntimeEventEnvelope, "contractVersion"> => ({
  directory: "/workspace",
  sessionId,
  payload: { type: "text-delta", delta },
})

const subagentEvent = (
  sessionId: string,
  subagentKey: string,
  status: "running" | "completed",
  revision: number,
): Omit<RuntimeEventEnvelope, "contractVersion"> => ({
  directory: "/workspace",
  sessionId,
  payload: { type: "subagent-updated", subagentKey, status, revision },
})

function mount(input: { authorize?: (parentSessionId: string) => boolean }) {
  const app = new Hono()
  const hub = createRuntimeEventHub()
  app.get("/runtime-events", runtimeEventsHandler(hub, {
    authorizeParent: (_context, parentSessionId) => input.authorize?.(parentSessionId) ?? true,
    resolveParentSessionId: (runtimeEvent) => runtimeEvent.sessionId.startsWith("child-")
      ? runtimeEvent.sessionId.slice("child-".length)
      : undefined,
  }))
  return { app, hub }
}

const managedPolicy = (authorize: SessionAccessPolicy["authorize"]): SessionAccessPolicy => ({
  sessionAuthority: "managed-private",
  authorize,
  authorizePrefix: authorize,
  filterSessions: (input) => input.sessionIds,
  registerSession: () => ({ allowed: true }),
})

function managedMount(authorize: SessionAccessPolicy["authorize"] = () => ({ allowed: true })) {
  const app = new Hono()
  const hub = createRuntimeEventHub()
  app.use("*", async (c, next) => {
    ;(c as any).set("relayHostAuth", {
      actor_id: "actor_1",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "editor",
    })
    await next()
  })
  app.get("/runtime-events", runtimeEventsHandler(hub, undefined, managedPolicy(authorize)))
  return { app, hub }
}

async function readUntil(response: Response, value: string) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (let reads = 0; reads < 20 && !text.includes(value); reads += 1) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  return text
}

describe("runtime event parent authorization", () => {
  test("managed streams require a parent scope and authorize it with verified relay identity", async () => {
    const seen: Parameters<SessionAccessPolicy["authorize"]>[0][] = []
    const { app } = managedMount((input) => {
      seen.push(input)
      return input.sessionId === "parent-a"
        ? { allowed: true }
        : { allowed: false, status: 403, code: "session_private", message: "private" }
    })

    const missing = await app.request("http://localhost/runtime-events")
    const denied = await app.request("http://localhost/runtime-events?parentSessionId=parent-b")
    const allowed = await app.request("http://localhost/runtime-events?parentSessionId=parent-a", {
      signal: AbortSignal.timeout(20),
    })

    expect(missing.status).toBe(400)
    expect(denied.status).toBe(403)
    expect(allowed.status).toBe(200)
    expect(seen.at(-1)).toMatchObject({
      operation: "session_event_stream",
      sessionId: "parent-a",
      actor: { actorId: "actor_1", actorKind: "human" },
      authority: { workspaceId: "ws_1", orgId: "org_1", role: "editor" },
    })
  })

  test("managed runtime stream filters retained parent frames without custom authorization", async () => {
    const { app, hub } = managedMount()
    hub.publishRuntime(event("parent-b", "denied-managed-replay"))
    hub.publishRuntime(event("parent-a", "allowed-managed-replay"))

    const controller = new AbortController()
    const response = await app.request("http://localhost/runtime-events?parentSessionId=parent-a", {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal,
    })
    const text = await readUntil(response, "allowed-managed-replay")
    controller.abort()

    expect(text).toContain("allowed-managed-replay")
    expect(text).not.toContain("denied-managed-replay")
  })

  test("filters replayed child events to the authorized parent", async () => {
    const { app, hub } = mount({})
    hub.publishRuntime(event("child-parent-a", "allowed-replay"))
    hub.publishRuntime(event("child-parent-b", "denied-replay"))

    const controller = new AbortController()
    const response = await app.request("http://localhost/runtime-events?parentSessionId=parent-a", {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal,
    })
    const text = await readUntil(response, "allowed-replay")
    controller.abort()

    expect(text).toContain("allowed-replay")
    expect(text).not.toContain("denied-replay")
  })

  test("replays a terminal child update to a late subscriber without crossing parent scope", async () => {
    const { app, hub } = mount({})
    hub.publishRuntime(subagentEvent("child-parent-a", "child-a", "completed", 3))
    hub.publishRuntime(subagentEvent("child-parent-b", "child-b", "completed", 7))
    // Evict the terminal frame from the ordinary ring. Terminal retention is
    // the recovery owner when the browser attaches after the parent stream has
    // already gone idle.
    for (let index = 0; index < 300; index += 1) {
      hub.publishRuntime(event("child-parent-a", `noise-${index}`))
    }

    const controller = new AbortController()
    const response = await app.request("http://localhost/runtime-events?parentSessionId=parent-a", {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal,
    })
    const text = await readUntil(response, '"subagentKey":"child-a"')
    controller.abort()

    expect(text).toContain('"subagentKey":"child-a"')
    expect(text).toContain('"status":"completed"')
    expect(text).not.toContain('"subagentKey":"child-b"')
  })

  test("filters live child events to the authorized parent", async () => {
    const { app, hub } = mount({})
    const controller = new AbortController()
    const response = await app.request("http://localhost/runtime-events?parentSessionId=parent-a", {
      signal: controller.signal,
    })
    hub.publishRuntime(event("child-parent-b", "denied-live"))
    hub.publishRuntime(event("child-parent-a", "allowed-live"))
    const text = await readUntil(response, "allowed-live")
    controller.abort()

    expect(text).toContain("allowed-live")
    expect(text).not.toContain("denied-live")
  })

  test("rejects a subscriber without access to the requested parent", async () => {
    const { app, hub } = mount({ authorize: () => false })
    hub.publishRuntime(event("child-parent-a", "secret-replay"))

    const response = await app.request("http://localhost/runtime-events?parentSessionId=parent-a", {
      headers: { "Last-Event-ID": "0" },
    })

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("secret-replay")
  })

  test("does not expose child events on the unscoped workspace stream", async () => {
    const { app, hub } = mount({})
    hub.publishRuntime(event("child-parent-a", "secret-child"))
    hub.publishRuntime(event("top-level", "visible-parent"))

    const controller = new AbortController()
    const response = await app.request("http://localhost/runtime-events", {
      headers: { "Last-Event-ID": "0" },
      signal: controller.signal,
    })
    const text = await readUntil(response, "visible-parent")
    controller.abort()

    expect(text).toContain("visible-parent")
    expect(text).not.toContain("secret-child")
  })

  test("workspace host applies parent authorization to its runtime stream", async () => {
    const eventHub = createRuntimeEventHub()
    const host = createWorkspaceHost({
      eventHub,
      runtimeEventAuthorization: {
        authorizeParent: (_context, parentSessionId) => parentSessionId === "parent-a",
        resolveParentSessionId: () => undefined,
      },
    })
    const app = new Hono()
    host.mount(app, {
      exposure: loopbackWorkspaceRuntimeExposure(),
      core: { upgradeWebSocket: (() => () => ({})) as never },
    })

    const response = await app.request("http://localhost/api/wr/runtime-events?parentSessionId=parent-b")
    host.dispose()

    expect(response.status).toBe(403)
  })
})
