import { afterEach, describe, expect, test } from "bun:test"
import { applySubagentPresentationEvent } from "@/features/session/subagents/subagent-ingress"
import {
  abortSubagentsForParent,
  applySubagentCompatLifecycleEvent,
  compatEventEnvelope,
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  nextLiveSession,
  partUpdateSupersedesDeltas,
  resetStreamGapState,
} from "@/app/providers/global-sdk/provider"
import { createSubagentRegistry } from "@/features/session/subagents/subagent-registry"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { shellDataKeys } from "@/platform/sync/keys"
import { sessionGoalKey, type SessionGoalData } from "@/features/session/store/session-goal-query"

afterEach(() => {
  queryClient.clear()
})

describe("global sdk stream bridge", () => {
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

  test("omitted workspace identity preserves the local SDK transport", () => {
    expect(globalSdkClientPlacement(undefined)).toBeUndefined()
    expect(globalSdkClientPlacement("  ")).toBeUndefined()
  })

  test("a subagent.updated frame lands in the registry as that parent's revision", () => {
    const registry = createSubagentRegistry()
    expect(applySubagentPresentationEvent({
      type: "subagent.updated",
      properties: {
        sessionID: "runtime-session-1",
        update: {
          subagentKey: "child-1",
          revision: 1,
          childSessionId: "child-session-1",
          transcript: { kind: "live", ref: "child-session-1" },
        },
      },
    }, registry)).toBe(true)
    expect(registry.get("runtime-session-1", "child-1")).toMatchObject({
      childSessionId: "child-session-1",
    })
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

  test("a frame with an empty directory is addressed by its session; control frames are not session events", () => {
    const payload = { type: "session.updated", properties: { sessionID: "central-one", info: { id: "central-one" } } }
    expect(compatEventEnvelope({ directory: "", payload })?.directory).toBe("central-one")
    expect(compatEventEnvelope({ directory: "workspace:another-workspace", payload })?.directory)
      .toBe("workspace:another-workspace")
    expect(compatEventEnvelope({ directory: "", payload: { type: "session.deleted", properties: { info: { id: "central-two" } } } })?.directory)
      .toBe("central-two")
    expect(compatEventEnvelope({ type: "pty.created", info: { id: "terminal-one" } })).toBeUndefined()
  })


  test("a stream's replay gap clears subagent state and invalidates the live session's read models", async () => {
    const subagents = createSubagentRegistry()
    subagents.apply("runtime-session-1", {
      type: "subagent-updated",
      subagentKey: "child-1",
      revision: 1,
      status: "running",
    })
    const rowKey = queryKeys.session.row("http://claxedo.test", "/repo/main", "runtime-session-1")
    const diffKey = shellDataKeys.sessionId("runtime-session-1", "diff")
    const goalScope = {
      sessionID: "runtime-session-1",
      directory: "/repo/main",
      serverUrl: "http://claxedo.test",
    }
    const goalKey = sessionGoalKey(goalScope)
    queryClient.setQueryData(rowKey, { id: "runtime-session-1" })
    queryClient.setQueryData(diffKey, [])
    queryClient.setQueryData<SessionGoalData>(goalKey, {
      capabilities: { implemented: true, available: true, actions: [], recovery: "reconcile", optionalFields: [] },
      goal: null,
    })

    await resetStreamGapState({
      baseUrl: "http://claxedo.test",
      directory: "/repo/main",
      sessionId: "runtime-session-1",
      subagents,
      goalScope,
    })

    expect(subagents.list()).toEqual([])
    expect(queryClient.getQueryState(rowKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true)
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
      hostKind: "provisioner",
    }, "cp-user-hosted-1", {
      directory: "/repo/.claxedo/user-hosted/workspaces/ws_user_hosted",
    })).toEqual({
      sessionID: "cp-user-hosted-1",
      directory: "/repo/.claxedo/user-hosted/workspaces/ws_user_hosted",
      workspaceId: undefined,
      hostKind: undefined,
    })
  })

  test("a same-workspace session switch keeps the workspace's subagents", () => {
    expect(liveSessionTransition({
      sessionID: "runtime-session-1",
      host: "workspace",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      hostKind: "machine",
    }, "runtime-session-2", {
      host: "workspace",
      directory: "/repo/main",
      workspaceId: "ws_signed",
      hostKind: "machine",
    })).toEqual({
      next: {
        sessionID: "runtime-session-2",
        host: "workspace",
        directory: "/repo/main",
        workspaceId: "ws_signed",
        hostKind: "machine",
      },
      workspaceScopeChanged: false,
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
      hostKind: "machine",
    })
  })


})
