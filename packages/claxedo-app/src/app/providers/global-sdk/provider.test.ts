import { afterEach, describe, expect, test } from "bun:test"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime"
import {
  applySubagentRuntimeEventEnvelope,
  abortSubagentsForParent,
  applySubagentCompatLifecycleEvent,
  compatEventEnvelope,
  createControlPlaneEventFetch,
  createGlobalSdkFetch,
  eventDirectoryForLiveSession,
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  runtimeEventLiveSession,
  nextLiveSession,
  partUpdateSupersedesDeltas,
  projectRuntimeEventEnvelope,
  rememberRuntimeEventEnvelope,
  resetRuntimeReplayGapState,
  runtimeEnvelope,
  runtimeProjectionOwnsCompat,
  runtimeReplayGap,
  shouldAcceptCompatEvent,
  workspaceEventTransport,
} from "@/app/providers/global-sdk/provider"
import {
  runtimeContractMismatch,
  runtimeContractMismatchEvents,
} from "@/app/providers/global-sdk/runtime-envelope"
import { createSubagentRegistry } from "@/features/session/subagents/subagent-registry"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { sessionGoalKey, type SessionGoalData } from "@/features/session/store/session-goal-query"

afterEach(() => {
  queryClient.clear()
})

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.toString()
  return input
}

function resolveSignedWorkspace(projects: Parameters<typeof signedWorkspaceFromProjects>[0]) {
  return (directory: string) => {
    const direct = signedWorkspaceFromProjects(projects, directory)
    if (direct) return direct
    const runtime = sessionWorkspaceRuntimeRef({ directory, projects })
    return runtime ? signedWorkspaceFromProjects(projects, runtime.workspaceId) : undefined
  }
}

function eventResponse() {
  return new Response("data: {}\n\n", { status: 200 })
}

function recordingFetch(calls: string[], respond: (url: string) => Response | Promise<Response> = () => eventResponse()): typeof fetch {
  return async (input) => {
    const url = requestUrl(input)
    calls.push(url)
    return respond(url)
  }
}

function recordingRequests(
  calls: Array<{ url: string; lastEventId: string | null }>,
  respond: (request: Request) => Response | Promise<Response> = () => eventResponse(),
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    calls.push({
      url: request.url,
      lastEventId: request.headers.get("Last-Event-ID"),
    })
    return respond(request)
  }
}

function setHappyDomUrl(url: string) {
  const happyDOM = Reflect.get(window, "happyDOM")
  if (!happyDOM || typeof happyDOM !== "object") throw new Error("missing happyDOM")
  const setURL = Reflect.get(happyDOM, "setURL")
  if (typeof setURL !== "function") throw new Error("missing happyDOM setURL")
  setURL.call(happyDOM, url)
}

function oldEventPath(url: string) {
  const pathname = new URL(url).pathname
  return pathname === "/global/event" || pathname === "/event"
}

describe("global sdk event fetch", () => {
  test("explicit workspace identity wins when the runtime directory is absent from inventory", () => {
    expect(globalSdkClientWorkspaceId([], {
      directory: "/runtime/repo",
      workspaceId: "ws_signed",
    })).toBe("ws_signed")
  })

  test("a workspace the inventory knows is local is never relay-routed, explicit id or not", () => {
    // Every claxedo workspace carries a uuid, local ones included, so a session
    // row's `workspaceId` is not evidence of a relay. Routing a local workspace
    // at the relay answers `401 Workspace connection failed` forever, and the
    // SDK reports that as `data: undefined` — indistinguishable, to the rail's
    // status batch, from "no session is active".
    const projects = [
      {
        worktree: "/repo/local",
        workspaces: {
          ws_local: {
            id: "ws_local",
            workspaceId: "ws_local",
            kind: "local",
            directory: "/repo/local",
          },
        },
      },
    ]
    expect(globalSdkClientWorkspaceId(projects, {
      directory: "/repo/local",
      workspaceId: "ws_local",
    })).toBeUndefined()
    expect(globalSdkClientPlacement(globalSdkClientWorkspaceId(projects, {
      directory: "/repo/local",
      workspaceId: "ws_local",
    }))).toBeUndefined()
    // An id the inventory cannot place keeps the optimistic fallback: a cloud
    // workspace whose projects have not loaded yet still reaches its relay.
    expect(globalSdkClientWorkspaceId(projects, {
      directory: "/repo/other",
      workspaceId: "ws_unknown",
    })).toBe("ws_unknown")
  })

  test("falls back to signed inventory for clients without explicit workspace identity", () => {
    expect(globalSdkClientWorkspaceId([
      {
        workspaces: {
          "/repo/main": {
            workspaceId: "ws_signed",
            kind: "cloud",
            directory: "/repo/main",
          },
        },
      },
    ], {
      directory: "/repo/main",
    })).toBe("ws_signed")
  })

  test("resolved workspace identity selects relay placement even on loopback before principal hydration", () => {
    expect(globalSdkClientPlacement("ws_signed")).toEqual({
      workspaceId: "ws_signed",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })

  test("secondary runtime events use the relay for a signed loopback workspace", () => {
    expect(workspaceEventTransport({
      serverUrl: "http://localhost:3001",
      signedControlPlane: true,
      workspaceId: "ws_signed",
      workspaceKind: "user-hosted",
    })).toBe("workspace-relay")
    expect(workspaceEventTransport({
      serverUrl: "http://localhost:3001",
      signedControlPlane: true,
      workspaceId: "ws_local",
      workspaceKind: "local",
    })).toBe("loopback")
  })

  test("omitted workspace identity preserves the local SDK transport", () => {
    expect(globalSdkClientPlacement(undefined)).toBeUndefined()
    expect(globalSdkClientPlacement("  ")).toBeUndefined()
  })

  test("routes remote signed workspace session lists through the workspace transport", async () => {
    const calls: Array<{ auth: string | null; dir: string | null; url: string }> = []
    const request: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? new Request(input, init) : new Request(input, init)
      calls.push({
        auth: req.headers.get("Authorization"),
        dir: req.headers.get("x-opencode-directory"),
        url: req.url,
      })
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_signed/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_signed",
          role: "owner",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_signed",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_signed/session") {
        return Response.json([{ id: "ses_1" }])
      }
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }
    const fetch = createGlobalSdkFetch({
      serverUrl: "https://control.test",
      resolveSignedWorkspace: resolveSignedWorkspace([
        {
          workspaces: {
            "/repo/main": {
              workspaceId: "ws_signed",
              kind: "cloud",
              directory: "/repo/main",
            },
          },
        },
      ]),
      request,
    })

    const response = await fetch("https://control.test/session?directory=%2Frepo%2Fmain")

    expect(await response.json()).toEqual([{ id: "ses_1" }])
    expect(calls).toEqual([
      {
        auth: null,
        dir: null,
        url: "https://control.test/api/workspace/ws_signed/connection",
      },
      {
        auth: "Bearer rat_signed",
        dir: "workspace:ws_signed",
        url: "https://relay.test/workspaces/ws_signed/session",
      },
    ])
  })

  test("leaves unsigned local session lists on the normal sdk fetch path", async () => {
    const calls: string[] = []
    const fetch = createGlobalSdkFetch({
      serverUrl: "http://127.0.0.1:3001",
      resolveSignedWorkspace: resolveSignedWorkspace([
        {
          workspaces: {
            "/repo/main": {
              workspaceId: "ws_local",
              kind: "local",
              directory: "/repo/main",
            },
          },
        },
      ]),
      request: async (input) => {
        calls.push(requestUrl(input))
        return Response.json([{ id: "local-session" }])
      },
    })

    const response = await fetch("http://127.0.0.1:3001/session?directory=%2Frepo%2Fmain")

    expect(await response.json()).toEqual([{ id: "local-session" }])
    expect(calls).toEqual(["http://127.0.0.1:3001/session?directory=%2Frepo%2Fmain"])
  })

  test("preserves a body-bearing request when signed routing has no workspace match", async () => {
    const calls: Array<{ body: string; header: string | null; url: string }> = []
    const request: typeof fetch = async (input, init) => {
      const next = input instanceof Request ? new Request(input, init) : new Request(input, init)
      calls.push({
        body: await next.text(),
        header: next.headers.get("x-request-override"),
        url: next.url,
      })
      return Response.json({ ok: true })
    }
    const fetch = createGlobalSdkFetch({
      serverUrl: "http://127.0.0.1:3001",
      resolveSignedWorkspace: resolveSignedWorkspace([]),
      request,
    })
    const input = new Request("http://127.0.0.1:3001/config?directory=%2Frepo%2Flocal", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local" }),
    })

    expect((await fetch(input, { headers: { "x-request-override": "kept" } })).status).toBe(200)
    expect(calls).toEqual([{
      body: JSON.stringify({ model: "local" }),
      header: "kept",
      url: "http://127.0.0.1:3001/config?directory=%2Frepo%2Flocal",
    }])
  })

  test("leaves signed local session lists on the normal sdk fetch path without a matching signed workspace", async () => {
    const calls: string[] = []
    const fetch = createGlobalSdkFetch({
      serverUrl: "http://127.0.0.1:3001",
      resolveSignedWorkspace: resolveSignedWorkspace([]),
      request: async (input) => {
        calls.push(requestUrl(input))
        return Response.json([{ id: "local-session" }])
      },
    })

    const response = await fetch("http://127.0.0.1:3001/session?directory=%2Frepo%2Fmain")

    expect(await response.json()).toEqual([{ id: "local-session" }])
    expect(calls).toEqual(["http://127.0.0.1:3001/session?directory=%2Frepo%2Fmain"])
  })

  test("keeps unresolved filesystem session inventory off a remote control plane", async () => {
    const calls: string[] = []
    const fetch = createGlobalSdkFetch({
      serverUrl: "https://control.test",
      resolveSignedWorkspace: resolveSignedWorkspace([]),
      request: async (input) => {
        calls.push(requestUrl(input))
        return Response.json([{ id: "must-not-leak" }])
      },
    })

    const response = await fetch("https://control.test/session?directory=%2Frepo%2Funresolved")

    expect(await response.json()).toEqual([])
    expect(calls).toEqual([])
  })

  test("routes a canonical signed workspace through the relay before principal hydration", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      calls.push(req.url)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_signed/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_signed",
          role: "owner",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_signed",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_signed/config") return Response.json({})
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }
    const fetch = createGlobalSdkFetch({
      serverUrl: "http://127.0.0.1:4527",
      resolveSignedWorkspace: resolveSignedWorkspace([{
        workspaces: {
          "/repo/main": { workspaceId: "ws_signed", kind: "cloud", directory: "/repo/main" },
        },
      }]),
      request,
    })

    expect((await fetch("http://127.0.0.1:4527/config?directory=%2Frepo%2Fmain")).status).toBe(200)
    expect(calls).toEqual([
      "http://127.0.0.1:4527/api/workspace/ws_signed/connection",
      "https://relay.test/workspaces/ws_signed/config",
    ])
  })

  test("routes workspace-ref headers supplied as Request overrides through the signed relay", async () => {
    const calls: string[] = []
    const request: typeof fetch = async (input, init) => {
      const req = new Request(input, init)
      calls.push(req.url)
      const url = new URL(req.url)
      if (url.pathname === "/api/workspace/ws_signed/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_signed",
          role: "owner",
          relayUrl: "https://relay.test",
          runtimeAccessToken: "rat_signed",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      if (url.toString() === "https://relay.test/workspaces/ws_signed/config") return Response.json({})
      throw new Error(`unexpected request: ${req.method} ${req.url}`)
    }
    const fetch = createGlobalSdkFetch({
      serverUrl: "http://127.0.0.1:4527",
      resolveSignedWorkspace: resolveSignedWorkspace([{
        workspaces: {
          "/repo/main": { workspaceId: "ws_signed", kind: "cloud", directory: "/repo/main" },
        },
      }]),
      request,
    })

    const input = new Request("http://127.0.0.1:4527/config", {
      headers: { "x-opencode-directory": "/stale/directory" },
    })
    expect((await fetch(input, {
      headers: { "x-opencode-directory": "workspace:ws_signed" },
    })).status).toBe(200)
    expect(calls).toEqual([
      "http://127.0.0.1:4527/api/workspace/ws_signed/connection",
      "https://relay.test/workspaces/ws_signed/config",
    ])
  })

  test("accepts only matching runtime event contract versions", () => {
    expect(runtimeEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toEqual({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })
    expect(runtimeEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION + 1,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toBeUndefined()
    expect(runtimeEnvelope({
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toBeUndefined()
  })

  test("names the incompatible contract version a dropped envelope came from", () => {
    const older = {
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION - 1,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    }
    expect(runtimeEnvelope(older)).toBeUndefined()
    expect(runtimeContractMismatch(older)).toEqual({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION - 1,
    })
    expect(runtimeContractMismatch({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toBeUndefined()
    // Heartbeats and compat frames carry no contract version and must not be
    // reported as an incompatible runtime.
    expect(runtimeContractMismatch({ type: "heartbeat" })).toBeUndefined()
    expect(runtimeContractMismatch({
      type: "session.idle",
      properties: { sessionID: "runtime-session-1" },
    })).toBeUndefined()
  })

  test("surfaces an incompatible runtime as a visible session error", () => {
    const events = runtimeContractMismatchEvents({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION - 1,
      sessionID: "runtime-session-1",
    })

    expect(events.map((event) => event.type)).toEqual(["runtime.diagnostic", "session.error"])
    const diagnostic = events[0]!.properties as { code?: string; severity?: string; message?: string }
    expect(diagnostic.code).toBe("runtime.contract_version_mismatch")
    expect(diagnostic.severity).toBe("error")
    expect(diagnostic.message).toContain("incompatible version")
    const sessionError = events[1]!.properties as {
      sessionID?: string
      error?: { data?: { message?: string } }
    }
    expect(sessionError.sessionID).toBe("runtime-session-1")
    expect(sessionError.error?.data?.message).toContain(`requires v${AGENT_RUNTIME_EVENT_CONTRACT_VERSION}`)
  })

  test("projects normalized runtime event envelopes into OpenCode-shaped events", () => {
    const events = projectRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      assistantMessageId: "assistant-1",
      payload: { type: "text-delta", delta: "hello" },
    })

    expect(events).toEqual([
      {
        directory: "/repo/main",
        payload: {
          id: "message.part.updated:assistant-1:000000_assistant-1-text",
          type: "message.part.updated",
          properties: {
            sessionID: "runtime-session-1",
            time: expect.any(Number),
            part: {
              id: "000000_assistant-1-text",
              sessionID: "runtime-session-1",
              messageID: "assistant-1",
              type: "text",
              text: "",
            },
          },
        },
      },
      {
        directory: "/repo/main",
        payload: {
          id: "message.part.delta:assistant-1:000000_assistant-1-text",
          type: "message.part.delta",
          properties: {
            sessionID: "runtime-session-1",
            messageID: "assistant-1",
            partID: "000000_assistant-1-text",
            field: "text",
            delta: "hello",
          },
        },
      },
    ])
  })

  test("admits subagent envelopes beside projection while compat projection remains empty", () => {
    const registry = createSubagentRegistry()
    const envelope = {
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: {
        type: "subagent-updated",
        subagentKey: "child-1",
        revision: 1,
        childSessionId: "child-session-1",
        transcript: { kind: "live", ref: "child-session-1" },
      },
    } as const

    expect(applySubagentRuntimeEventEnvelope(envelope, registry)).toBe(true)
    expect(registry.get("runtime-session-1", "child-1")).toMatchObject({
      childSessionId: "child-session-1",
    })
    expect(projectRuntimeEventEnvelope(envelope)).toEqual([])
  })

  test("session delete removes subagents and parent abort interrupts only foreground children", () => {
    const registry = createSubagentRegistry()
    registry.apply("parent-1", {
      type: "subagent-updated",
      subagentKey: "foreground",
      revision: 4,
      mode: "foreground",
      status: "running",
    })
    registry.apply("parent-1", {
      type: "subagent-updated",
      subagentKey: "background",
      revision: 2,
      mode: "background",
      status: "running",
    })

    abortSubagentsForParent("parent-1", registry)
    expect(registry.get("parent-1", "foreground")).toMatchObject({
      status: "interrupted",
      fieldRevisions: { status: 5 },
    })
    expect(registry.get("parent-1", "background")?.status).toBe("running")
    expect(applySubagentCompatLifecycleEvent({
      type: "session.deleted",
      properties: { info: { id: "parent-1" } },
    } as never, registry)).toBe(true)
    expect(registry.list("parent-1")).toEqual([])
  })

  test("reuses runtime projections by root session while routing events to the current directory", () => {
    const projections = new Map()
    projectRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/first",
      sessionId: "runtime-session-1",
      assistantMessageId: "assistant-1",
      payload: { type: "text-delta", delta: "hello" },
    }, projections)

    const events = projectRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/alias",
      sessionId: "runtime-session-1",
      assistantMessageId: "assistant-1",
      payload: { type: "text-delta", delta: " again" },
    }, projections)

    expect(projections.size).toBe(1)
    expect(events.map((event) => event.directory)).toEqual(["/repo/alias"])
    expect(events[0]?.payload.type).toBe("message.part.delta")
  })

  test("keeps runtime projection state across step-start when the envelope key is stable", () => {
    const projections = new Map()
    projectRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      assistantMessageId: "assistant-1",
      payload: { type: "step-start", newMessageId: "assistant-2" },
    }, projections)

    const events = projectRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      assistantMessageId: "assistant-1",
      payload: { type: "text-delta", delta: "after step" },
    }, projections)

    expect(projections.size).toBe(1)
    expect(events[0]?.payload).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: {
          messageID: "assistant-2",
        },
      },
    })
  })

  test("drops legacy compat events by session id when normalized runtime events cover the session", () => {
    const covered = new Set<string>()
    rememberRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    }, covered)

    expect(shouldAcceptCompatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "runtime-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "",
        },
      },
    } as never, covered)).toBe(false)
    expect(shouldAcceptCompatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "runtime-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "",
        },
      },
    } as never, covered)).toBe(false)
  })

  test("accepts (does not crash on) a payload-less keepalive frame", () => {
    const covered = new Set<string>()
    // Heartbeat/keepalive frames (`{"type":"heartbeat"}`) reach the compat
    // gate with no event payload. Reading `.type` off `undefined` previously
    // threw and killed the whole event loop ("event stream failed: Cannot read
    // properties of undefined (reading 'type')"). The gate must tolerate it.
    expect(shouldAcceptCompatEvent(undefined as never, covered)).toBe(true)
    expect(shouldAcceptCompatEvent(null as never, covered)).toBe(true)
  })

  test("parses compat SSE envelopes without treating heartbeat frames as events", () => {
    expect(compatEventEnvelope({ type: "heartbeat" })).toBeUndefined()
    expect(compatEventEnvelope({ payload: { type: "server.heartbeat", properties: {} } })).toBeUndefined()
    expect(compatEventEnvelope({
      directory: "/repo/main",
      payload: {
        type: "message.part.delta",
        properties: { sessionID: "session-1" },
      },
    })).toEqual({
      directory: "/repo/main",
      payload: {
        type: "message.part.delta",
        properties: { sessionID: "session-1" },
      },
    })
    expect(compatEventEnvelope({
      type: "server.connected",
      id: "server.connected",
      properties: {},
    })).toEqual({
      payload: {
        id: "server.connected",
        type: "server.connected",
        properties: {},
      },
    })
  })

  test("leaves OpenCode session events owned by the OpenCode compat stream", () => {
    expect(runtimeProjectionOwnsCompat({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "ses_1",
      payload: { type: "text-delta", delta: "hello" },
    })).toBe(false)
    expect(runtimeProjectionOwnsCompat({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toBe(true)
  })

  test("detects runtime replay gap notices", () => {
    expect(runtimeReplayGap({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: {
        type: "harness-notice",
        code: "runtime.sse_replay_gap",
        message: "Replay cursor is stale",
      },
    })).toBe(true)
    expect(runtimeReplayGap({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "__runtime__",
      payload: {
        type: "harness-notice",
        code: "runtime.sse_replay_gap",
        message: "Replay cursor is stale",
      },
    })).toBe(true)
    expect(runtimeReplayGap({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "text-delta", delta: "hello" },
    })).toBe(false)
  })

  test("runtime replay gaps reset projections and invalidate session read models", async () => {
    const projections = new Map([["runtime-session-1:assistant-1", {} as never]])
    const covered = new Set(["runtime-session-1"])
    const subagents = createSubagentRegistry()
    subagents.apply("runtime-session-1", {
      type: "subagent-updated",
      subagentKey: "child-1",
      revision: 1,
      status: "running",
    })
    const rowKey = queryKeys.session.row("http://claxedo.test", "/repo/main", "runtime-session-1")
    const messagesKey = queryKeys.session.messages("http://claxedo.test", "/repo/main", "runtime-session-1")
    const goalScope = {
      sessionID: "runtime-session-1",
      directory: "/repo/main",
      serverUrl: "http://claxedo.test",
    }
    const goalKey = sessionGoalKey(goalScope)
    queryClient.setQueryData(rowKey, { id: "runtime-session-1" })
    queryClient.setQueryData(messagesKey, [{ info: { id: "assistant-1" } }])
    queryClient.setQueryData<SessionGoalData>(goalKey, {
      capabilities: { implemented: true, available: true, actions: [], recovery: "reconcile", optionalFields: [] },
      goal: null,
    })

    await resetRuntimeReplayGapState({
      envelope: {
        contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
        directory: "/repo/main",
        sessionId: "runtime-session-1",
        payload: {
          type: "harness-notice",
          code: "runtime.sse_replay_gap",
          message: "Replay cursor is stale",
        },
      },
      projections,
      covered,
      baseUrl: "http://claxedo.test",
      subagents,
      goalScope,
    })

    expect(projections.size).toBe(0)
    expect(covered.size).toBe(0)
    expect(subagents.list()).toEqual([])
    expect(queryClient.getQueryState(rowKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(messagesKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(goalKey)?.isInvalidated).toBe(true)
  })

  test("drops mirrored compat events for runtime-owned sessions even before runtime coverage arrives", () => {
    const covered = new Set<string>()

    expect(shouldAcceptCompatEvent({
      type: "permission.asked",
      properties: {
        sessionID: "runtime-session-1",
        permissionID: "permission-1",
        title: "Run command",
        metadata: {},
      },
    } as never, covered)).toBe(false)
    expect(shouldAcceptCompatEvent({
      type: "permission.replied",
      properties: {
        sessionID: "runtime-session-1",
        permissionID: "permission-1",
        response: "once",
      },
    } as never, covered)).toBe(false)
    expect(shouldAcceptCompatEvent({
      type: "question.asked",
      properties: {
        sessionID: "runtime-session-1",
        questionID: "question-1",
        title: "Choose",
      },
    } as never, covered)).toBe(false)
    expect(shouldAcceptCompatEvent({
      type: "session.status",
      properties: {
        sessionID: "runtime-session-1",
        status: "recovering",
      },
    } as never, covered)).toBe(false)
  })

  test("keeps mirrored compat events for legacy OpenCode sessions", () => {
    const covered = new Set<string>()

    expect(shouldAcceptCompatEvent({
      type: "permission.asked",
      properties: {
        sessionID: "ses_1",
        permissionID: "permission-1",
        title: "Run command",
        metadata: {},
      },
    } as never, covered)).toBe(true)
  })

  test("keeps terminal compat status for OpenCode while suppressing runtime-owned duplicates", () => {
    const covered = new Set<string>()
    rememberRuntimeEventEnvelope({
      contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      payload: { type: "session-status", status: "idle" },
    }, covered)

    expect(shouldAcceptCompatEvent({
      type: "session.idle",
      properties: { sessionID: "ses_opencode_1" },
    } as never, covered)).toBe(true)
    expect(shouldAcceptCompatEvent({
      type: "session.idle",
      properties: { sessionID: "runtime-session-1" },
    } as never, covered)).toBe(false)
    expect(shouldAcceptCompatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "runtime-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "duplicate",
        },
      },
    } as never, covered)).toBe(false)
  })

  test("empty text part updates do not supersede following deltas", () => {
    expect(partUpdateSupersedesDeltas({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "runtime-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "",
        },
      },
    } as never)).toBe(false)
    expect(partUpdateSupersedesDeltas({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "runtime-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "complete",
        },
      },
    } as never)).toBe(true)
  })

  test("live session updates clear stale workspace identity when the session scope changes", () => {
    expect(nextLiveSession({
      sessionID: "cp-cloud-1",
      directory: "ws_cloud",
      workspaceId: "ws_cloud",
      workspaceKind: "cloud",
    }, "cp-user-hosted-1", {
      directory: "/repo/.claxedo/user-hosted/workspaces/ws_user_hosted",
    })).toEqual({
      sessionID: "cp-user-hosted-1",
      directory: "/repo/.claxedo/user-hosted/workspaces/ws_user_hosted",
      workspaceId: undefined,
      workspaceKind: undefined,
    })
  })

  test("same-workspace session switches rebind runtime events without clearing workspace subagents", () => {
    expect(liveSessionTransition({
      sessionID: "runtime-session-1",
      host: "workspace",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      workspaceKind: "user-hosted",
    }, "runtime-session-2", {
      host: "workspace",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      workspaceKind: "user-hosted",
    })).toEqual({
      next: {
        sessionID: "runtime-session-2",
        host: "workspace",
        directory: "/repo/main",
        workspaceId: "ws_signed",
        workspaceKind: "user-hosted",
      },
      workspaceScopeChanged: false,
      runtimeStreamChanged: true,
    })
  })

  test("live session relay backing resolves signed user-hosted filesystem directories", () => {
    expect(liveSessionWithRelayBacking({
      sessionID: "cp-user-hosted-1",
      directory: "/private/tmp/ws/.claxedo/user-hosted/workspaces/ws_user_hosted",
    }, [{
      id: "project-1",
      worktree: "/tmp/ws",
      time: { created: 1, updated: 1 },
      workspaces: {
        ws_user_hosted: {
          workspaceId: "ws_user_hosted",
          kind: "user-hosted",
          directory: "/tmp/ws/.claxedo/user-hosted/workspaces/ws_user_hosted",
        },
      },
    }])).toEqual({
      sessionID: "cp-user-hosted-1",
      directory: "/private/tmp/ws/.claxedo/user-hosted/workspaces/ws_user_hosted",
      workspaceId: "ws_user_hosted",
      workspaceKind: "user-hosted",
    })
  })

  test("runtime events wait for a real authorized parent session", () => {
    expect(runtimeEventLiveSession(undefined, [])).toBeUndefined()
    expect(runtimeEventLiveSession({
      sessionID: "route",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      workspaceKind: "cloud",
    }, [])).toBeUndefined()
    expect(runtimeEventLiveSession({
      sessionID: "runtime-session-1",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      workspaceKind: "cloud",
    }, [])).toEqual({
      sessionID: "runtime-session-1",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      workspaceKind: "cloud",
    })
  })

  test("event directory routing prefers typed workspaceId over directory shape", () => {
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "/repo/alias",
        workspaceId: "ws_typed",
      },
    })).toBe("ws_typed")
  })

  test("event directory routing keeps legacy workspace-id directory fallback only when workspaceId is absent", () => {
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "ws_legacy",
      },
    })).toBe("ws_legacy")
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "workspace:ws_legacy",
      },
    })).toBe("ws_legacy")
    expect(eventDirectoryForLiveSession({
      directory: "global",
      liveSession: {
        sessionID: "session-1",
        directory: "ws_legacy",
      },
    })).toBe("global")
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "/repo/local",
      },
    })).toBe("/runtime/repo")
  })

  test("signed mode sends idle global events to the control-plane lifecycle stream", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => undefined,
      setLiveSession: () => {},
      fetch: recordingFetch(calls),
    })("http://claxedo.test/global/event")

    expect(calls).toEqual(["http://claxedo.test/api/wr/events"])
    expect(calls.some(oldEventPath)).toBe(false)
  })

  test("signed loopback idle global events route to the lifecycle stream", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => undefined,
      setLiveSession: () => {},
      fetch: recordingFetch(calls),
    })("http://localhost:3001/global/event")

    expect(calls).toEqual(["http://localhost:3001/api/wr/events"])
    expect(calls.some(oldEventPath)).toBe(false)
  })

  test("signed loopback cloud workspace routes idle global events to the lifecycle stream", async () => {
    const calls: string[] = []
    const previous = window.location.href
    setHappyDomUrl(`http://localhost/${btoa("ws_1").replace(/=/g, "")}/session`)

    try {
      await createControlPlaneEventFetch({
        signedControlPlane: () => true,
        liveSession: () => undefined,
        setLiveSession: () => {},
        fetch: recordingFetch(calls),
      })("http://localhost:3001/global/event")
    } finally {
      setHappyDomUrl(previous)
    }

    expect(calls).toEqual(["http://localhost:3001/api/wr/events"])
    expect(calls.some(oldEventPath)).toBe(false)
  })

  test("signed session events resolve workspace and avoid OpenCode-compatible paths", async () => {
    const calls: string[] = []
    const liveSession: { sessionID: string; directory: string; workspaceId?: string } = { sessionID: "session-1", directory: "/repo" }
    const request = recordingFetch(calls, (url) => {
      if (url.includes("/workspace/resolve")) {
        return new Response(JSON.stringify({ workspaceId: "ws_1", kind: "cloud" }), { status: 200 })
      }
      if (url.includes("/api/workspace/ws_1/connection")) {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          role: "owner",
          relayUrl: "http://claxedo.test",
          runtimeAccessToken: "runtime-token",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      return eventResponse()
    })

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => liveSession,
      setLiveSession: (next) => Object.assign(liveSession, next),
      fetch: request,
    })("http://claxedo.test/global/event?sessionID=session-1")

    expect(calls).toEqual([
      "http://claxedo.test/api/workspace/resolve?directory=%2Frepo",
      "http://claxedo.test/api/workspace/ws_1/connection",
      "http://claxedo.test/workspaces/ws_1/global/event?sessionID=session-1",
    ])
    expect(calls.some((url) => oldEventPath(url) || new URL(url).pathname.startsWith("/session/"))).toBe(false)
  })

  test("signed loopback local session events stay on the local stream", async () => {
    const calls: string[] = []
    const liveSession: { sessionID: string; directory: string; workspaceId?: string } = { sessionID: "session-1", directory: "/repo" }
    const request = recordingFetch(calls, (url) => {
      if (url.includes("/workspace/resolve")) {
        return new Response(JSON.stringify({ workspaceId: "ws_local", kind: "local" }), { status: 200 })
      }
      return eventResponse()
    })

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => liveSession,
      setLiveSession: (next) => Object.assign(liveSession, next),
      fetch: request,
    })("http://localhost:3001/global/event?sessionID=session-1")

    expect(calls).toEqual([
      "http://localhost:3001/api/claxedo/workspace/resolve?directory=%2Frepo",
      "http://localhost:3001/global/event?sessionID=session-1",
    ])
    expect(liveSession.workspaceId).toBeUndefined()
  })

  test("signed loopback local session reconnects keep using the local stream", async () => {
    const calls: string[] = []
    const liveSession: { sessionID: string; directory: string; workspaceId?: string } = { sessionID: "session-1", directory: "/repo" }
    const request = recordingFetch(calls, (url) => {
      if (url.includes("/workspace/resolve")) {
        return new Response(JSON.stringify({ workspaceId: "ws_local", kind: "local" }), { status: 200 })
      }
      return eventResponse()
    })
    const eventFetch = createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => liveSession,
      setLiveSession: (next) => Object.assign(liveSession, next),
      fetch: request,
    })

    await eventFetch("http://localhost:3001/global/event?sessionID=session-1")
    await eventFetch("http://localhost:3001/global/event?sessionID=session-1")

    expect(calls).toEqual([
      "http://localhost:3001/api/claxedo/workspace/resolve?directory=%2Frepo",
      "http://localhost:3001/global/event?sessionID=session-1",
      "http://localhost:3001/global/event?sessionID=session-1",
    ])
    expect(liveSession.workspaceId).toBeUndefined()
  })

  test("signed real-directory event workspace resolution is Query-owned across reconnects", async () => {
    const calls: string[] = []
    const request = recordingFetch(calls, (url) => {
      if (url.includes("/workspace/resolve")) {
        return new Response(JSON.stringify({ workspaceId: "ws_event_query", kind: "cloud" }), { status: 200 })
      }
      if (url.includes("/api/workspace/ws_event_query/connection")) {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_event_query",
          role: "owner",
          relayUrl: "http://claxedo.test",
          runtimeAccessToken: "runtime-token",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      return eventResponse()
    })
    const eventFetch = createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => ({ sessionID: "session-query", directory: "/repo/query-owned-events" }),
      setLiveSession: () => {},
      fetch: request,
    })

    await eventFetch("http://claxedo.test/global/event?sessionID=session-query")
    await eventFetch("http://claxedo.test/global/event?sessionID=session-query")

    expect(calls.filter((url) => url.includes("/workspace/resolve"))).toEqual([
      "http://claxedo.test/api/workspace/resolve?directory=%2Frepo%2Fquery-owned-events",
    ])
    expect(calls.filter((url) => url.includes("/workspaces/ws_event_query/global/event"))).toEqual([
      "http://claxedo.test/workspaces/ws_event_query/global/event?sessionID=session-query",
      "http://claxedo.test/workspaces/ws_event_query/global/event?sessionID=session-query",
    ])
  })

  test("signed workspace-id session events use Workspace Relay even on loopback", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = []
    const liveSession: { sessionID: string; directory: string; workspaceId?: string } = {
      sessionID: "session-1",
      directory: "ws_1",
    }
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
      })
      if (req.url.includes("/workspace/resolve")) {
        return new Response(JSON.stringify({ workspaceId: "ws_1", kind: "cloud" }), { status: 200 })
      }
      if (req.url.includes("/api/workspace/ws_1/connection")) {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          role: "owner",
          relayUrl: "http://localhost:3001",
          runtimeAccessToken: "runtime-token",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      return eventResponse()
    }

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => liveSession,
      setLiveSession: (next) => Object.assign(liveSession, next),
      fetch: request as typeof fetch,
    })("http://localhost:3001/global/event?sessionID=session-1")

    expect(calls).toEqual([
      {
        url: "http://localhost:3001/api/workspace/ws_1/connection",
        authorization: null,
      },
      {
        url: "http://localhost:3001/workspaces/ws_1/global/event?sessionID=session-1",
        authorization: "Bearer runtime-token",
      },
    ])
  })

  test("unsigned workspace-id global events use the loopback workspace runtime proxy", async () => {
    const calls: string[] = []
    const request = recordingFetch(calls, (url) => {
      if (url.includes("/api/workspace/ws_1/connection")) {
        return new Response(JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_1",
          role: "owner",
          relayUrl: "http://localhost:3001",
          runtimeAccessToken: "runtime-token",
          tokenExpiresAt: Date.now() + 120_000,
        }), { status: 200 })
      }
      return eventResponse()
    })

    await createControlPlaneEventFetch({
      signedControlPlane: () => false,
      liveSession: () => ({ sessionID: "session-1", directory: "ws_1", workspaceId: "ws_1" }),
      setLiveSession: () => {},
      fetch: request,
    })("http://localhost:3001/global/event")

    expect(calls).toEqual([
      "http://localhost:3001/workspaces/ws_1/global/event",
    ])
  })

  test("signed-out local directory events stay on the canonical loopback stream", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => false,
      liveSession: () => ({ sessionID: "session-local", directory: "/repo/local" }),
      setLiveSession: () => {},
      fetch: recordingFetch(calls),
    })("http://localhost:3001/global/event?sessionID=session-local")

    expect(calls).toEqual([
      "http://localhost:3001/global/event?sessionID=session-local",
    ])
    expect(calls.some((url) => url.includes("/api/workspace/resolve"))).toBe(false)
  })

  test("managed workspace runtime event reconnects preserve canonical session scope and Last-Event-ID", async () => {
    const calls: Array<{ url: string; lastEventId: string | null }> = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => ({
        sessionID: "session-1",
        directory: "ws_1",
        workspaceId: "ws_1",
        workspaceKind: "cloud",
      }),
      setLiveSession: () => {},
      fetch: recordingRequests(calls, (request) => {
        if (request.url.includes("/api/workspace/ws_1/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_1",
            role: "owner",
            relayUrl: "http://localhost:3001",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 120_000,
          }), { status: 200 })
        }
        return eventResponse()
      }),
    })(new Request("http://localhost:3001/global/event", {
      headers: { "Last-Event-ID": "9" },
    }))

    expect(calls.at(-1)).toMatchObject({
      url: "http://localhost:3001/workspaces/ws_1/global/event?sessionID=session-1",
      lastEventId: "9",
    })
  })

  test("signed session events rewrite sdk /event path to the workspace runtime", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => ({ sessionID: "session-1", workspaceId: "ws_event_rewrite" }),
      setLiveSession: () => {},
      fetch: recordingFetch(calls, (url) => {
        if (url.includes("/api/workspace/ws_event_rewrite/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_event_rewrite",
            role: "owner",
            relayUrl: "http://claxedo.test",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 120_000,
          }), { status: 200 })
        }
        return eventResponse()
      }),
    })("http://claxedo.test/event?sessionID=session-1")

    expect(calls).toEqual([
      "http://claxedo.test/api/workspace/ws_event_rewrite/connection",
      "http://claxedo.test/workspaces/ws_event_rewrite/event?sessionID=session-1",
    ])
    expect(calls.some(oldEventPath)).toBe(false)
  })

  test("signed global events append the canonical live session when sdk omits query params", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => ({ sessionID: "session-2", workspaceId: "ws_2" }),
      setLiveSession: () => {},
      fetch: recordingFetch(calls, (url) => {
        if (url.includes("/api/workspace/ws_2/connection")) {
          return new Response(JSON.stringify({
            access: "cloud",
            backing: "cloud-vm",
            workspaceId: "ws_2",
            role: "owner",
            relayUrl: "http://claxedo.test",
            runtimeAccessToken: "runtime-token",
            tokenExpiresAt: Date.now() + 120_000,
          }), { status: 200 })
        }
        return eventResponse()
      }),
    })("http://claxedo.test/global/event")

    expect(calls).toEqual([
      "http://claxedo.test/api/workspace/ws_2/connection",
      "http://claxedo.test/workspaces/ws_2/global/event?sessionID=session-2",
    ])
  })

  test("workspace-route sentinels discard stale caller session scope and stay on the signed lifecycle stream", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => true,
      liveSession: () => ({
        sessionID: "route",
        workspaceId: "ws_route_only",
        workspaceKind: "cloud",
      }),
      setLiveSession: () => {},
      fetch: recordingFetch(calls),
    })("http://claxedo.test/global/event?sessionID=stale-session")

    expect(calls).toEqual(["http://claxedo.test/api/wr/events"])
  })

  test("unmanaged local event streams remain unscoped when the sdk omits a session query", async () => {
    const calls: string[] = []

    await createControlPlaneEventFetch({
      signedControlPlane: () => false,
      liveSession: () => ({ sessionID: "session-local", directory: "/repo/local" }),
      setLiveSession: () => {},
      fetch: recordingFetch(calls),
    })("http://localhost:3001/global/event")

    expect(calls).toEqual(["http://localhost:3001/global/event"])
  })
})
