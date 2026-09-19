import { afterEach, describe, expect, test, vi } from "vitest"
import { queryClient } from "@/platform/query/query-client"
import type { SessionRef } from "@/platform/identity/session-ref"
import { sessionCapabilitiesKey } from "./session-pane-queries"

const harness = vi.hoisted(() => ({
  pending: [] as Array<{
    signal?: AbortSignal
    resolve: (response: Response) => void
    reject: (error: unknown) => void
  }>,
}))

const unusedGoalTransport = vi.hoisted(() => () => {
  throw new Error("the capabilities suite does not drive goal mutations")
})

// Query lifetime owns deduplication/cancellation; transport placement has its
// own public-route tests. Control only the response timing at this boundary.
vi.mock("./session-transport", () => ({
  fetchSessionCapabilitiesByTransport: (input: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
    const pending = { signal: input.signal, resolve, reject }
    pending.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    harness.pending.push(pending)
  }).then(response => response.json()),
  // `session-goal-query` binds these four into a module-level mutation record, so
  // the mock must define them even though this suite never drives a goal mutation.
  pauseSessionGoalByTransport: unusedGoalTransport,
  resumeSessionGoalByTransport: unusedGoalTransport,
  stopSessionGoalByTransport: unusedGoalTransport,
  deleteSessionGoalByTransport: unusedGoalTransport,
}))

import {
  sessionCapabilitiesTransportRequestKey,
  syncSessionCapabilitiesData,
} from "./session-capabilities-query"

const capabilities = {
  transport: "codex-acp" as const,
  reconnect: false,
  replay: true,
  permissions: true,
  questions: false,
  todos: true,
  commands: false,
  abort: true,
  fork: true,
  revert: false,
  unrevert: false,
  configOptions: true,
}

const request = {
  directory: "/repo/a",
  sessionID: "0251fd86-2f35-4efe-a802-b2fd6d473992",
  claxedoServerUrl: "http://test.local",
}

const capabilityKey = (input: typeof request & {
  signedControlPlane?: boolean
  workspaceId?: string
  hostKind?: "provisioner" | "machine"
  sessionRef?: SessionRef
}) => sessionCapabilitiesKey({
  sessionID: input.sessionID,
  directory: input.directory,
  serverUrl: input.claxedoServerUrl,
  signedControlPlane: input.signedControlPlane,
  workspaceId: input.workspaceId,
  hostKind: input.hostKind,
  sessionRef: input.sessionRef,
})

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
  harness.pending.length = 0
})

describe("session capabilities query ownership", () => {
  test("keeps request closures ephemeral and rejects a late result after A to B", async () => {
    let currentSessionID: string | undefined = request.sessionID
    let currentDirectory: string | undefined = request.directory
    const first = syncSessionCapabilitiesData({
      request,
      currentSessionID: () => currentSessionID,
      currentDirectory: () => currentDirectory,
    })

    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    const requestKey = sessionCapabilitiesTransportRequestKey(request)
    expect(queryClient.getQueryCache().find({ queryKey: requestKey })?.options.queryFn).toBeTypeOf("function")
    expect(queryClient.getQueryData(capabilityKey(request))).toBeUndefined()

    currentSessionID = "ses_b"
    currentDirectory = "/repo/b"
    harness.pending[0].resolve(Response.json(capabilities))
    await expect(first).resolves.toBe(false)

    expect(queryClient.getQueryCache().find({ queryKey: requestKey })).toBeUndefined()
    expect(queryClient.getQueryData(capabilityKey(request))).toBeUndefined()

    currentSessionID = request.sessionID
    currentDirectory = request.directory
    const second = syncSessionCapabilitiesData({
      request,
      currentSessionID: () => currentSessionID,
      currentDirectory: () => currentDirectory,
    })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2))
    harness.pending[1].resolve(Response.json(capabilities))
    await expect(second).resolves.toBe(true)

    const canonical = queryClient.getQueryCache().find({
      queryKey: capabilityKey(request),
    })
    expect(canonical?.state.data).toEqual(capabilities)
    expect(canonical?.options.queryFn).not.toBeTypeOf("function")
    expect(queryClient.getQueryCache().find({ queryKey: requestKey })).toBeUndefined()
  })

  test("aborts the transport and removes its ephemeral query with the activation", async () => {
    const activation = new AbortController()
    const result = syncSessionCapabilitiesData({
      request,
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
      signal: activation.signal,
    })

    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    activation.abort()
    await expect(result).resolves.toBe(false)
    expect(harness.pending[0]?.signal?.aborted).toBe(true)
    expect(queryClient.getQueryCache().find({
      queryKey: sessionCapabilitiesTransportRequestKey(request),
    })).toBeUndefined()
    expect(queryClient.getQueryData(capabilityKey(request))).toBeUndefined()
  })

  test("one consumer abort does not cancel another consumer of the shared transport request", async () => {
    const firstActivation = new AbortController()
    const secondActivation = new AbortController()
    const ownership = {
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
    }
    const first = syncSessionCapabilitiesData({ request, ...ownership, signal: firstActivation.signal })
    const second = syncSessionCapabilitiesData({ request, ...ownership, signal: secondActivation.signal })

    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    firstActivation.abort()
    await expect(first).resolves.toBe(false)
    expect(harness.pending[0]?.signal?.aborted).toBe(false)

    harness.pending[0].resolve(Response.json(capabilities))
    await expect(second).resolves.toBe(true)
    expect(queryClient.getQueryData(capabilityKey(request))).toEqual(capabilities)
    await vi.waitFor(() => expect(queryClient.getQueryCache().find({
      queryKey: sessionCapabilitiesTransportRequestKey(request),
    })).toBeUndefined())
  })

  test("does not remove a request that is reacquired while final release is cancelling", async () => {
    const firstActivation = new AbortController()
    const secondActivation = new AbortController()
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const originalCancel = queryClient.cancelQueries.bind(queryClient)
    let cancelCalls = 0
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries").mockImplementation(async (filters, options) => {
      cancelCalls += 1
      if (cancelCalls === 1) return await cancelGate
      return await originalCancel(filters, options)
    })
    const ownership = {
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
    }

    const first = syncSessionCapabilitiesData({ request, ...ownership, signal: firstActivation.signal })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    firstActivation.abort()
    await vi.waitFor(() => expect(cancelCalls).toBe(1))

    const requestKey = sessionCapabilitiesTransportRequestKey(request)
    const second = syncSessionCapabilitiesData({ request, ...ownership, signal: secondActivation.signal })
    await vi.waitFor(() => expect(
      queryClient.getQueryCache().find({ queryKey: requestKey })?.getObserversCount(),
    ).toBe(1))

    releaseCancel()
    await expect(first).resolves.toBe(false)
    expect(queryClient.getQueryCache().find({ queryKey: requestKey })).toBeDefined()
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2))
    expect(harness.pending[0]?.signal?.aborted).toBe(true)

    harness.pending[1].resolve(Response.json(capabilities))
    await expect(second).resolves.toBe(true)
    await vi.waitFor(() => expect(queryClient.getQueryCache().find({ queryKey: requestKey })).toBeUndefined())
    cancelSpy.mockRestore()
  })

  test("dedupes the same placement through the canonical transport authority", async () => {
    const firstRequest = { ...request }
    const secondRequest = { ...request }
    const ownership = {
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
    }

    const first = syncSessionCapabilitiesData({ request: firstRequest, ...ownership })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    const firstKey = sessionCapabilitiesTransportRequestKey(firstRequest)
    const second = syncSessionCapabilitiesData({ request: secondRequest, ...ownership })
    const secondKey = sessionCapabilitiesTransportRequestKey(secondRequest)

    expect(firstKey).toEqual(secondKey)
    harness.pending[0].resolve(Response.json(capabilities))
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  test("does not dedupe or overwrite capabilities across servers", async () => {
    const firstRequest = { ...request, claxedoServerUrl: "https://one.example" }
    const secondRequest = { ...request, claxedoServerUrl: "https://two.example" }
    const ownership = {
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
    }

    const first = syncSessionCapabilitiesData({ request: firstRequest, ...ownership })
    const second = syncSessionCapabilitiesData({ request: secondRequest, ...ownership })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2))

    const secondCapabilities = { ...capabilities, reconnect: true }
    harness.pending[0].resolve(Response.json(capabilities))
    harness.pending[1].resolve(Response.json(secondCapabilities))
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    expect(sessionCapabilitiesTransportRequestKey(firstRequest)).not.toEqual(
      sessionCapabilitiesTransportRequestKey(secondRequest),
    )
    expect(capabilityKey(firstRequest)).not.toEqual(capabilityKey(secondRequest))
    expect(queryClient.getQueryData(capabilityKey(firstRequest))).toEqual(capabilities)
    expect(queryClient.getQueryData(capabilityKey(secondRequest))).toEqual(secondCapabilities)
  })

  test("isolates the same opaque session id across workspace placements", async () => {
    const firstRequest = {
      ...request,
      sessionRef: { sessionId: request.sessionID, host: "workspace", workspaceId: "ws_1" } satisfies SessionRef,
    }
    const secondRequest = {
      ...request,
      sessionRef: { sessionId: request.sessionID, host: "workspace", workspaceId: "ws_2" } satisfies SessionRef,
    }
    const first = syncSessionCapabilitiesData({
      request: firstRequest,
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
    })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(1))
    harness.pending[0].resolve(Response.json(capabilities))
    await expect(first).resolves.toBe(true)

    const secondCapabilities = { ...capabilities, reconnect: true }
    const second = syncSessionCapabilitiesData({
      request: secondRequest,
      currentSessionID: () => request.sessionID,
      currentDirectory: () => request.directory,
    })
    await vi.waitFor(() => expect(harness.pending).toHaveLength(2))
    harness.pending[1].resolve(Response.json(secondCapabilities))
    await expect(second).resolves.toBe(true)

    expect(capabilityKey(firstRequest)).not.toEqual(capabilityKey(secondRequest))
    expect(queryClient.getQueryData(capabilityKey(firstRequest))).toEqual(capabilities)
    expect(queryClient.getQueryData(capabilityKey(secondRequest))).toEqual(secondCapabilities)
  })

  test("isolates user-hosted and cloud refs with the same visible placement", () => {
    const userHostedRequest = {
      ...request,
      workspaceId: "ws_1",
      signedControlPlane: true,
      hostKind: "provisioner" as const,
      sessionRef: {
        sessionId: request.sessionID,
        host: "workspace",
        workspaceId: "ws_1",
        toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "machine", hostId: "host_local" },
        harness: { kind: "native", harnessId: "opencode" },
      } satisfies SessionRef,
    }
    const workspaceRequest = {
      ...userHostedRequest,
      sessionRef: {
        sessionId: request.sessionID,
        host: "workspace",
        workspaceId: "ws_1",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_1",
          hosting: "provisioner",
          hostId: "host_1",
        },
        harness: { kind: "native", harnessId: "opencode" },
      } satisfies SessionRef,
    }

    expect(capabilityKey(userHostedRequest)).not.toEqual(capabilityKey(workspaceRequest))
    expect(sessionCapabilitiesTransportRequestKey(userHostedRequest)).not.toEqual(
      sessionCapabilitiesTransportRequestKey(workspaceRequest),
    )
  })

  test("lets a complete SessionRef dominate incomplete redundant workspace routing fields", () => {
    const sessionRef = {
      sessionId: request.sessionID,
      host: "workspace",
      workspaceId: "ws_authoritative",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_authoritative",
        hosting: "machine",
        hostId: "host_1",
      },
      harness: { kind: "connection", connectionId: "codex-team" },
    } satisfies SessionRef
    const complete = {
      ...request,
      signedControlPlane: true,
      workspaceId: "ws_authoritative",
      hostKind: "machine" as const,
      sessionRef,
    }
    const staleRedundantFields = {
      ...complete,
      workspaceId: "stale-redundant-value",
      hostKind: "provisioner" as const,
    }

    expect(capabilityKey(complete)).toEqual(capabilityKey(staleRedundantFields))
    expect(sessionCapabilitiesTransportRequestKey(complete).slice(0, -1)).toEqual(
      sessionCapabilitiesTransportRequestKey(staleRedundantFields).slice(0, -1),
    )
  })
})
