import { afterEach, describe, expect, test } from "bun:test"
import { openWorkspaceRuntimeEventResponse } from "../global-sdk-event-fetch"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION } from "@claxedo/agent-event-runtime"
import {
  applySubagentRuntimeEventEnvelope,
  abortSubagentsForParent,
  applySubagentCompatLifecycleEvent,
  compatEventEnvelope,
  eventDirectoryForLiveSession,
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  runtimeEventLiveSession,
  nextLiveSession,
  partUpdateSupersedesDeltas,
  projectRuntimeDiagnosticEnvelope,
  resetRuntimeReplayGapState,
  runtimeEnvelope,
  runtimeReplayGap,
  workspaceEventTransport,
  sseJsonStream,
} from "@/app/providers/global-sdk/provider"
import {
  runtimeContractMismatch,
  runtimeContractMismatchEvents,
} from "@/app/providers/global-sdk/runtime-envelope"
import { createSubagentRegistry } from "@/features/session/subagents/subagent-registry"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { sessionGoalKey, type SessionGoalData } from "@/features/session/store/session-goal-query"
import { requestUrl } from "@/lib/url"

afterEach(() => {
  queryClient.clear()
})

describe("global sdk event fetch", () => {
  test("aborting a retargeted stream discards buffered frames and their cursors", async () => {
    const controller = new AbortController()
    const cursors: string[] = []
    const stream = sseJsonStream(new Response('id: 1\ndata: {"sessionId":"old"}\n\nid: 2\ndata: {"sessionId":"old"}\n\n'), controller.signal, (id) => cursors.push(id))
    expect(await stream.next()).toEqual({ value: { sessionId: "old" }, done: false })
    controller.abort()
    expect((await stream.next()).done).toBe(true)
    expect(cursors).toEqual(["1"])
  })
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
    expect(projectRuntimeDiagnosticEnvelope(envelope)).toEqual([])
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



  test("parses compat SSE envelopes without treating heartbeat frames as events", () => {
    expect(compatEventEnvelope({ type: "heartbeat" })).toBeUndefined()
    expect(compatEventEnvelope({ payload: { type: "server.heartbeat", properties: {} } })).toBeUndefined()
    // A type named by neither contract is dropped at the boundary rather than
    // enqueued: subscribers are keyed by the union, so nothing could read it.
    expect(compatEventEnvelope({ payload: { type: "workspace.invented", properties: {} } })).toBeUndefined()
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

  test("global presentation events retain producer scope and use explicit central session identity", () => {
    const payload = { type: "session.updated", properties: { sessionID: "central-one", info: { id: "central-one" } } }
    expect(compatEventEnvelope({ directory: "", payload })?.directory).toBe("central-one")
    expect(compatEventEnvelope({ directory: "workspace:another-workspace", payload })?.directory)
      .toBe("workspace:another-workspace")
    expect(compatEventEnvelope({ directory: "", payload: { type: "session.deleted", properties: { info: { id: "central-two" } } } })?.directory)
      .toBe("central-two")
    expect(compatEventEnvelope({ type: "pty.created", info: { id: "terminal-one" } })).toBeUndefined()
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

  test("runtime replay gaps clear subagent state and invalidate session read models", async () => {
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
      baseUrl: "http://claxedo.test",
      subagents,
      goalScope,
    })

    expect(subagents.list()).toEqual([])
    expect(queryClient.getQueryState(rowKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(messagesKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(goalKey)?.isInvalidated).toBe(true)
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

  test("runtime events open for the session the scope names, on the route's workspace identity", () => {
    // ATTACH: the route names a running session this client never created, so
    // nothing has marked a live session yet — only the workspace-route sentinel
    // exists. The scope owner supplies the session; the sentinel supplies the
    // relay identity to route the stream with.
    expect(runtimeEventLiveSession({
      sessionID: "route",
      directory: "ws_user_hosted",
      workspaceId: "ws_user_hosted",
      workspaceKind: "user-hosted",
    }, [], "ses_attached")).toEqual({
      sessionID: "ses_attached",
      directory: "ws_user_hosted",
      workspaceId: "ws_user_hosted",
      workspaceKind: "user-hosted",
    })
  })

  test("runtime events retarget to the scope when the live session is the one left behind", () => {
    // A navigation from one session to another must move the stream even though
    // the live session still names the session whose history was fetched last.
    expect(runtimeEventLiveSession({
      sessionID: "ses_previous",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      workspaceKind: "cloud",
    }, [], "ses_next")?.sessionID).toBe("ses_next")
  })

  test("event directory routing prefers typed workspaceId over directory shape", () => {
    // The frame's own `/runtime/repo` is the HOST's path and addresses nothing
    // here; the workspace's address is what every consumer is keyed by.
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "/repo/alias",
        workspaceId: "ws_typed",
      },
    })).toBe("workspace:ws_typed")
  })

  test("event directory routing keeps legacy workspace-id directory fallback only when workspaceId is absent", () => {
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "ws_legacy",
      },
    })).toBe("workspace:ws_legacy")
    expect(eventDirectoryForLiveSession({
      directory: "/runtime/repo",
      liveSession: {
        sessionID: "session-1",
        directory: "workspace:ws_legacy",
      },
    })).toBe("workspace:ws_legacy")
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

  test("a live session's events are addressed the same way its pane and its session row are", () => {
    // One owner for the address: `sessionRowDirectory`. A pane on a
    // relay-backed workspace registers its conversation under that exact
    // string (`conversationScopeKey` is an exact match), so an event published
    // under the bare id reaches no pane at all.
    const workspaceId = "ws_attached"
    expect(eventDirectoryForLiveSession({
      directory: "/host/machine/worktree",
      liveSession: { sessionID: "run_attached", directory: "/host/machine/worktree", workspaceId },
    })).toBe(sessionRowDirectory({ workspaceId, hostDirectory: "/host/machine/worktree" }))
  })


  test("runtime event transport sends the private parent and replay cursor through the relay", async () => {
    const calls: Request[] = []
    const controller = new AbortController()
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      calls.push(req)
      if (new URL(req.url).pathname === "/api/workspace/ws_private/connection") {
        return Response.json({
          access: "cloud",
          backing: "cloud-vm",
          workspaceId: "ws_private",
          role: "owner",
          relayUrl: "http://claxedo.test",
          runtimeAccessToken: "runtime-token",
          tokenExpiresAt: Date.now() + 120_000,
        })
      }
      return new Response("data: {\"type\":\"heartbeat\"}\n\n")
    }) as typeof fetch
    await openWorkspaceRuntimeEventResponse({
      serverUrl: "http://claxedo.test",
      signedControlPlane: true,
      session: { sessionID: "private-session", workspaceId: "ws_private", workspaceKind: "cloud" },
      request,
      init: { signal: controller.signal, headers: { "Last-Event-ID": "cursor-9" } },
    })
    const stream = calls.at(-1)!
    expect(stream.url).toBe("http://claxedo.test/workspaces/ws_private/api/wr/runtime-events?parentSessionId=private-session")
    expect(stream.headers.get("Last-Event-ID")).toBe("cursor-9")
    expect(stream.headers.get("Authorization")).toBe("Bearer runtime-token")
    controller.abort()
    expect(stream.signal.aborted).toBe(true)
  })

  test("runtime event transport rejects route sentinels before requesting a private stream", () => {
    const calls: string[] = []
    const request = (async (input: RequestInfo | URL) => {
      calls.push(requestUrl(input))
      return new Response("")
    }) as typeof fetch
    for (const sessionID of ["route", "", " "]) {
      expect(() => openWorkspaceRuntimeEventResponse({
        request,
        serverUrl: "http://claxedo.test",
        session: { sessionID, workspaceId: "ws_private", workspaceKind: "cloud" },
        signedControlPlane: true,
        init: {},
      })).toThrow("Runtime events require a session identity")
    }
    expect(calls).toEqual([])
  })

  test("local runtime events retain directory scope and parent identity", async () => {
    const calls: Request[] = []
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return new Response("")
    }) as typeof fetch
    await openWorkspaceRuntimeEventResponse({
      request,
      serverUrl: "http://localhost:3001",
      session: { sessionID: "local-session", directory: "/repo/local", workspaceKind: "local" },
      signedControlPlane: false,
      init: {},
    })
    const url = new URL(calls.at(-1)!.url)
    expect(url.pathname).toBe("/api/wr/runtime-events")
    expect(url.searchParams.get("directory")).toBe("/repo/local")
    expect(url.searchParams.get("parentSessionId")).toBe("local-session")
    expect(calls).toHaveLength(1)
  })
})
