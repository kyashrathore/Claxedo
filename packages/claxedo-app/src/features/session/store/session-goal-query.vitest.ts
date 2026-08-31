import { afterEach, describe, expect, test, vi } from "vitest"
import type { SessionRef } from "@/platform/identity/session-ref"
import { queryClient } from "@/platform/query/query-client"
import type { SessionGoalData } from "./session-goal-query"

const harness = vi.hoisted(() => ({
  pending: [] as Array<{
    url: string
    method: string
    signal?: AbortSignal
    resolve: (response: Response) => void
    reject: (error: unknown) => void
  }>,
}))

vi.mock("@/platform/api/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/platform/api/api")>()
  return {
    ...original,
    authFetch: (input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const pending = {
        url: input instanceof Request ? input.url : String(input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        signal: init?.signal ?? undefined,
        resolve,
        reject,
      }
      pending.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      harness.pending.push(pending)
    }),
    apiBearerToken: async () => null,
  }
})

import {
  applySessionGoalRuntimeEvent,
  mutateSessionGoalData,
  sessionGoalKey,
  syncSessionGoalData,
} from "./session-goal-query"

const sessionRef = {
  sessionId: "ses_1",
  host: "workspace",
  workspaceId: "ws_1",
  harness: { id: "codex" },
  toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "cloud", hostId: "host_1" },
} satisfies SessionRef

const scope = {
  sessionID: "ses_1",
  directory: "/repo/main",
  serverUrl: "http://127.0.0.1:3001",
}

const authorityScope = {
  ...scope,
  serverUrl: "https://control.test",
  signedControlPlane: true,
  workspaceId: "ws_1",
  workspaceKind: "cloud" as const,
  sessionRef,
}

const request = {
  client: {} as never,
  directory: scope.directory,
  sessionID: scope.sessionID,
  claxedoServerUrl: scope.serverUrl,
}

const capabilities = {
  implemented: true,
  available: true,
  actions: ["pause", "resume", "delete"] as const,
  recovery: "reconcile" as const,
  optionalFields: ["tokensUsed"] as const,
}

const activeGoal = {
  sessionId: scope.sessionID,
  objective: "Ship verified work",
  status: "active" as const,
  createdAt: 10,
  updatedAt: 20,
}

afterEach(() => {
  queryClient.clear()
  harness.pending.length = 0
  vi.restoreAllMocks()
})

async function resolveGoalRead(goal = activeGoal) {
  const capabilitiesRequest = harness.pending.find((item) => item.url.includes("/goal/capabilities"))
  capabilitiesRequest?.resolve(Response.json(capabilities))
  await vi.waitFor(() => expect(harness.pending).toHaveLength(2))
  const goalRequest = harness.pending.find((item) => item.url.includes("/goal?") && item.method === "GET")
  goalRequest?.resolve(Response.json(goal))
}

describe("session Goal authority", () => {
  test("late reads cannot overwrite the newly active session", async () => {
    let currentSessionID: string | undefined = scope.sessionID
    let currentDirectory: string | undefined = scope.directory
    const read = syncSessionGoalData({
      request,
      currentSessionID: () => currentSessionID,
      currentDirectory: () => currentDirectory,
    })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))

    currentSessionID = "ses_2"
    currentDirectory = "/repo/other"
    await resolveGoalRead()

    await expect(read).resolves.toBe(false)
    expect(queryClient.getQueryData(sessionGoalKey(scope))).toBeUndefined()
  })

  test("keys isolate harness, host, and workspace authority for the same visible session", () => {
    const cursor = sessionGoalKey({
      ...authorityScope,
      sessionRef: { ...sessionRef, harness: { id: "cursor" } },
    })
    const otherHost = sessionGoalKey({
      ...authorityScope,
      sessionRef: {
        ...sessionRef,
        toolSandbox: { ...sessionRef.toolSandbox, hostId: "host_2" },
      },
    })
    const otherWorkspace = sessionGoalKey({
      ...authorityScope,
      workspaceId: "ws_2",
      sessionRef: { ...sessionRef, workspaceId: "ws_2" },
    })

    expect(cursor).not.toEqual(sessionGoalKey(authorityScope))
    expect(otherHost).not.toEqual(sessionGoalKey(authorityScope))
    expect(otherWorkspace).not.toEqual(sessionGoalKey(authorityScope))
  })

  test("runtime events update only the exact authority and reject older snapshots", () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(authorityScope), { capabilities, goal: activeGoal })
    const otherScope = { ...authorityScope, sessionRef: { ...sessionRef, harness: { id: "cursor" } } satisfies SessionRef }
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(otherScope), { capabilities, goal: null })

    expect(applySessionGoalRuntimeEvent({
      scope: authorityScope,
      sessionId: scope.sessionID,
      payload: { type: "goal-updated", sessionId: scope.sessionID, goal: { ...activeGoal, status: "paused", updatedAt: 19 } },
    })).toBe(false)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(authorityScope))?.goal?.status).toBe("active")

    expect(applySessionGoalRuntimeEvent({
      scope: authorityScope,
      sessionId: scope.sessionID,
      payload: { type: "goal-updated", sessionId: scope.sessionID, goal: { ...activeGoal, status: "paused", updatedAt: 21 } },
    })).toBe(true)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(authorityScope))?.goal?.status).toBe("paused")
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(otherScope))?.goal).toBeNull()
  })

  test("unsupported ACP hydration caches capabilities without reading Goal state", async () => {
    const sync = syncSessionGoalData({
      request,
      currentSessionID: () => scope.sessionID,
      currentDirectory: () => scope.directory,
    })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    harness.pending[0]!.resolve(Response.json({
      implemented: false,
      available: false,
      unavailableReason: "ACP Goal extension was not advertised",
      actions: [],
      recovery: "blocked",
      optionalFields: [],
    }))

    await expect(sync).resolves.toBe(true)
    expect(harness.pending).toHaveLength(1)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))).toMatchObject({
      capabilities: { implemented: false, available: false },
      goal: null,
    })
  })

  test("a late hydration response cannot overwrite a newer runtime event", async () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(scope), { capabilities, goal: activeGoal })
    const sync = syncSessionGoalData({
      request,
      currentSessionID: () => scope.sessionID,
      currentDirectory: () => scope.directory,
    })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    harness.pending[0]!.resolve(Response.json(capabilities))
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2))

    const newer = { ...activeGoal, status: "paused" as const, updatedAt: 30 }
    expect(applySessionGoalRuntimeEvent({
      scope,
      sessionId: scope.sessionID,
      payload: { type: "goal-updated", sessionId: scope.sessionID, goal: newer },
    })).toBe(true)
    harness.pending[1]!.resolve(Response.json(activeGoal))

    await expect(sync).resolves.toBe(false)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal).toEqual(newer)
  })

  test("pending and failed actions never hide the authoritative Goal", async () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(scope), { capabilities, goal: activeGoal })

    const pause = mutateSessionGoalData({ request, mutation: "pause" })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal).toEqual(activeGoal)
    // The runtime serializes a `failed` mutation result with HTTP 502
    // (`workspace-runtime` `routes/session-core.ts:goalMutationResponse`), so
    // the fake must too — a 200 here would exercise a transport the server
    // never produces.
    harness.pending[0]!.resolve(Response.json({ ok: false, status: "failed", message: "provider refused" }, { status: 502 }))

    await expect(pause).rejects.toMatchObject({ name: "SessionGoalMutationError", status: "failed" })
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal).toEqual(activeGoal)
  })

  test("successful actions update the same server-qualified authority key that was read", async () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(scope), { capabilities, goal: activeGoal })
    const pause = mutateSessionGoalData({ request, mutation: "pause" })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    const paused = { ...activeGoal, status: "paused" as const, updatedAt: 21 }
    harness.pending[0]!.resolve(Response.json({ ok: true, goal: paused }))

    await expect(pause).resolves.toEqual(paused)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal).toEqual(paused)
    expect(queryClient.getQueryData(sessionGoalKey({ ...scope, serverUrl: undefined }))).toBeUndefined()
  })

  test("a late mutation response cannot resurrect a runtime-cleared Goal", async () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(scope), { capabilities, goal: activeGoal })
    const pause = mutateSessionGoalData({ request, mutation: "pause" })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    expect(applySessionGoalRuntimeEvent({
      scope,
      sessionId: scope.sessionID,
      payload: { type: "goal-cleared", sessionId: scope.sessionID },
    })).toBe(true)
    harness.pending[0]!.resolve(Response.json({
      ok: true,
      goal: { ...activeGoal, status: "paused", updatedAt: 21 },
    }))

    await expect(pause).resolves.toMatchObject({ status: "paused" })
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(scope))?.goal).toBeNull()
  })
})
