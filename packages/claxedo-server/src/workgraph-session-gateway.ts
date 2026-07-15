import path from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import type { ConnectionsService } from "@claxedo/connections"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import { WorkGraphAttemptToolRoutes, WorkGraphConnectionToolRoutes } from "@claxedo/workspace-runtime"
import {
  WorkGraphAttemptIdentitySchema,
  type CommandResult,
  type WorkGraphAttemptOperationRequest,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import { OPENCODE_INTERNAL_BASE } from "./opencode-engine"
import { createConnectionOperationBroker } from "./workgraph-host/connection-operation-broker"
import { createWorkGraphConnectionsPort } from "./workgraph-host/connections"
import type { WorkGraphSessionGateway } from "./workgraph-host/local-execution"

type SessionV2WorkGraphGatewayOptions = (Readonly<{
  connections?: undefined
  connectors?: Readonly<Record<string, SourceIssueConnector>>
}> | Readonly<{
  connections: ConnectionsService
  connectors?: Readonly<Record<string, SourceIssueConnector>>
  resolveTeamOwner(context: WorkGraphContext): string | undefined
}>) & Readonly<{
  executeAttempt?: (
    context: WorkGraphContext,
    request: WorkGraphAttemptOperationRequest,
    signal: AbortSignal,
  ) => Promise<CommandResult>
  attemptContexts?: Readonly<{
    bind(input: Readonly<{
      identity: WorkGraphAttemptOperationRequest["identity"]
      context: WorkGraphContext
    }>): Promise<void>
    release(sessionId: string): Promise<void>
  }>
}>

export type WorkGraphSessionBinding = Readonly<{
  attemptId: string
  sessionId: string
  runtimeSessionId?: string
  directory: string
  harness: string
}>

export type WorkGraphSessionBindingStore = Readonly<{
  all(): Promise<readonly WorkGraphSessionBinding[]>
  findByAttempt(attemptId: string): Promise<WorkGraphSessionBinding | undefined>
  findBySession(sessionId: string): Promise<WorkGraphSessionBinding | undefined>
  save(binding: WorkGraphSessionBinding): Promise<void>
  deleteByAttempt?(attemptId: string): Promise<void>
  deleteByDirectory(directory: string): Promise<void>
}>

const bindingWrites = new Map<string, Promise<void>>()

/** Durable local index used by compensation and reconciliation after a server restart. */
export function createFileWorkGraphSessionBindingStore(file: string): WorkGraphSessionBindingStore {
  let loaded: Promise<WorkGraphSessionBinding[]> | undefined
  const read = () => loaded ??= (async () => {
    const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (source === undefined) return []
    const root = record(JSON.parse(source))
    if (root?.version !== 1 || !Array.isArray(root.bindings)) {
      throw new Error("WorkGraph Session binding index is malformed")
    }
    return root.bindings.map((value): WorkGraphSessionBinding => {
      const row = record(value)
      const attemptId = clean(row?.attemptId)
      const sessionId = clean(row?.sessionId)
      const runtimeSessionId = clean(row?.runtimeSessionId)
      const directory = clean(row?.directory)
      const harness = clean(row?.harness)
      if (!attemptId || !sessionId || !directory || !harness) {
        throw new Error("WorkGraph Session binding index contains an invalid binding")
      }
      return { attemptId, sessionId, ...(runtimeSessionId ? { runtimeSessionId } : {}), directory, harness }
    })
  })()
  const write = async (bindings: WorkGraphSessionBinding[]) => {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, bindings }))
    await rename(temporary, file)
    loaded = Promise.resolve(bindings)
  }
  const update = async (change: (bindings: WorkGraphSessionBinding[]) => WorkGraphSessionBinding[]) => {
    const previous = bindingWrites.get(file) ?? Promise.resolve()
    const current = previous.then(async () => {
      const bindings = await read()
      const next = change(bindings)
      if (next === bindings) return
      await write(next)
    })
    bindingWrites.set(file, current)
    try {
      await current
    } finally {
      if (bindingWrites.get(file) === current) bindingWrites.delete(file)
    }
  }
  return {
    all: async () => [...await read()],
    findByAttempt: async (attemptId) => (await read()).find((binding) => binding.attemptId === attemptId),
    findBySession: async (sessionId) => (await read()).find((binding) => binding.sessionId === sessionId),
    save: async (binding) => update((bindings) => [
      ...bindings.filter((item) => item.attemptId !== binding.attemptId && item.sessionId !== binding.sessionId),
      binding,
    ]),
    deleteByAttempt: async (attemptId) => update((bindings) => {
      const next = bindings.filter((binding) => binding.attemptId !== attemptId)
      return next.length === bindings.length ? bindings : next
    }),
    deleteByDirectory: async (directory) => update((bindings) => {
      const next = bindings.filter((binding) => binding.directory !== directory)
      return next.length === bindings.length ? bindings : next
    }),
  }
}

/** Routes OpenCode through durable Session V2 and every other Session composer
 * harness through the shared harness-aware Session runtime. */
export function createHarnessWorkGraphGateway(
  opencodeRequest: OpenCodeRequestFn,
  options: SessionV2WorkGraphGatewayOptions & Readonly<{
    sessionRequest(directory: string, request: Request): Promise<Response>
    releaseSessionRuntime?(directory: string): Promise<void>
    bindings?: WorkGraphSessionBindingStore
  }>,
): WorkGraphSessionGateway {
  const v2 = createSessionV2WorkGraphGateway(opencodeRequest, options)
  const memory = new Map<string, WorkGraphSessionBinding>()
  const bindings = options.bindings ?? {
    all: async () => [...memory.values()],
    findByAttempt: async (attemptId: string) => memory.get(attemptId),
    findBySession: async (sessionId: string) => [...memory.values()].find((binding) => binding.sessionId === sessionId),
    save: async (binding: WorkGraphSessionBinding) => { memory.set(binding.attemptId, binding) },
    deleteByAttempt: async (attemptId: string) => { memory.delete(attemptId) },
    deleteByDirectory: async (directory: string) => {
      for (const [attemptId, binding] of memory) {
        if (binding.directory === directory) memory.delete(attemptId)
      }
    },
  }
  const request = async (binding: Pick<WorkGraphSessionBinding, "directory" | "harness">, pathname: string, init?: RequestInit) => {
    const url = new URL(pathname, "http://workgraph-session.local")
    url.searchParams.set("directory", binding.directory)
    url.searchParams.set("harness", binding.harness)
    const response = await options.sessionRequest(binding.directory, new Request(url, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      ...(init?.body ? { duplex: "half" as const } : {}),
    } as RequestInit))
    if (response.ok) return response
    throw new HarnessSessionRequestError(pathname, response.status, await response.text())
  }
  const cleanupAttemptBinding = async (binding: WorkGraphSessionBinding) => {
    if (!options.attemptContexts) return
    const cleanup = await Promise.allSettled([
      request(binding, `/api/workgraph/attempt-binding/${encodeURIComponent(binding.sessionId)}`, { method: "DELETE" }),
      options.attemptContexts.release(binding.sessionId),
    ])
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
  }
  return {
    supportsConnections: v2.supportsConnections,
    classifyAdmissionError: (error) =>
      error instanceof HarnessSessionRequestError ? classifySessionRequest(error.status) : v2.classifyAdmissionError?.(error) ?? "indeterminate",
    admit: async (input) => {
      if (input.profile.harness === "opencode") return v2.admit(input)
      if (input.profile.connectionIds.length > 0) {
        throw new Error("Connection-bound Attempts currently require the OpenCode harness")
      }
      if (input.leaseEpoch !== undefined && options.executeAttempt) {
        if (!input.context) throw new Error("WorkGraph Attempt tools require the owner context")
        if (!options.attemptContexts) throw new Error("WorkGraph Attempt tools require a trusted local context registry")
      }
      const existing = await bindings.findByAttempt(input.attemptId)
      const binding = existing ?? await (async () => {
        const created = await request({ directory: input.directory, harness: input.profile.harness }, "/session", {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            model: {
              providerID: input.profile.model.providerId,
              modelID: input.profile.model.modelId,
            },
          }),
        })
        const body = record(await created.json())
        const runtimeSessionId = clean(body?.id)
        if (!runtimeSessionId) throw new Error("Harness Session create response did not include a Session ID")
        const next = {
          attemptId: input.attemptId,
          sessionId: input.sessionId ?? runtimeSessionId,
          ...(input.sessionId && input.sessionId !== runtimeSessionId ? { runtimeSessionId } : {}),
          directory: input.directory,
          harness: input.profile.harness,
        }
        await bindings.save(next)
        return next
      })()
      try {
        if (input.leaseEpoch !== undefined && options.executeAttempt) {
          const identity = WorkGraphAttemptIdentitySchema.parse({
            attemptId: input.attemptId,
            sessionId: binding.sessionId,
            workspaceId: input.workspaceId ?? input.directory,
            leaseEpoch: input.leaseEpoch,
          })
          await options.attemptContexts!.bind({ identity, context: input.context! }).catch(async (error) => {
            await bindings.deleteByAttempt?.(input.attemptId)
            throw error
          })
          await request(binding, "/api/workgraph/attempt-binding", {
            method: "POST",
            body: JSON.stringify({
              version: 1,
              identity,
              ...(runtimeSessionId(binding) === binding.sessionId
                ? {}
                : { runtimeSessionId: runtimeSessionId(binding) }),
              harness: input.profile.harness,
              brokerUrl: "http://127.0.0.1",
            }),
          })
        }
        await request(binding, `/session/${encodeURIComponent(runtimeSessionId(binding))}/prompt_async`, {
          method: "POST",
          ...(existing ? { headers: { "x-claxedo-idempotency-retry": "1" } } : {}),
          body: JSON.stringify({
            messageID: `msg_workgraph_${input.attemptId}`,
            parts: [{ type: "text", text: input.prompt }],
            agent: input.profile.agent,
            model: {
              providerID: input.profile.model.providerId,
              modelID: input.profile.model.modelId,
            },
            variant: input.profile.effort,
          }),
        })
      } catch (error) {
        if (error instanceof HarnessSessionRequestError) {
          await Promise.allSettled([
            cleanupAttemptBinding(binding),
            bindings.deleteByAttempt?.(input.attemptId),
          ])
        }
        throw error
      }
      return binding.sessionId
    },
    cancel: async (sessionId, reason) => {
      const binding = await bindings.findBySession(sessionId)
      if (!binding) return v2.cancel(sessionId, reason)
      const results = await Promise.allSettled([
        request(binding, `/session/${encodeURIComponent(runtimeSessionId(binding))}/abort`, { method: "POST" }),
        cleanupAttemptBinding(binding),
      ])
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failure) throw failure.reason
    },
    result: async (sessionId) => {
      const binding = await bindings.findBySession(sessionId)
      if (!binding) return v2.result(sessionId)
      const runtimeId = runtimeSessionId(binding)
      const session = record(await request(binding, `/session/${encodeURIComponent(runtimeId)}`).then((response) => response.json()))
      const status = clean(session?.status)
      if (status === "busy" || status === "recovering" || status === "retry") return { state: "running" }
      const lastTurn = record(session?.lastTurn)
      if (lastTurn?.status === "failed") {
        await cleanupAttemptBinding(binding)
        return { state: "failed", message: clean(lastTurn.error) ?? "Harness Session failed" }
      }
      if (lastTurn?.status === "cancelled") {
        await cleanupAttemptBinding(binding)
        return { state: "cancelled" }
      }
      if (lastTurn?.status !== "completed") return { state: "pending" }
      await cleanupAttemptBinding(binding)
      const messages = await request(binding, `/session/${encodeURIComponent(runtimeId)}/message`).then((response) => response.json())
      const summary = assistantSummary(messages)
      if (!summary) return { state: "failed", message: "session_output_missing" }
      return { state: "succeeded", summary, artifacts: [] }
    },
    releaseDirectory: async (directory) => {
      const cleanup = await Promise.allSettled(
        (await bindings.all()).filter((binding) => binding.directory === directory).map(cleanupAttemptBinding),
      )
      await bindings.deleteByDirectory(directory)
      await options.releaseSessionRuntime?.(directory)
      const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failure) throw failure.reason
    },
  }
}

function runtimeSessionId(binding: WorkGraphSessionBinding) {
  return binding.runtimeSessionId ?? binding.sessionId
}

/** Session V2 transport used by the local embedded WorkGraph execution adapter. */
export function createSessionV2WorkGraphGateway(
  opencodeRequest: OpenCodeRequestFn,
  options: SessionV2WorkGraphGatewayOptions = {},
): WorkGraphSessionGateway {
  const bridges = new Map<string, ReturnType<typeof WorkGraphConnectionToolRoutes>>()
  const attemptBridges = new Map<string, ReturnType<typeof WorkGraphAttemptToolRoutes>>()
  type ToolRegistration = Readonly<{
    sessionId: string
    callbackUrl: string
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>
  }>
  const registrations = new Map<string, Map<string, ToolRegistration>>()
  const request = async (pathname: string, init?: RequestInit, directory?: string) => {
    const response = await opencodeRequest(
      new Request(`${OPENCODE_INTERNAL_BASE}${pathname}`, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(directory ? { "x-opencode-directory": directory } : {}),
          ...init?.headers,
        },
        ...(init?.body ? { duplex: "half" as const } : {}),
      } as RequestInit),
    )
    if (response.ok) return response
    throw new SessionV2RequestError(pathname, response.status, await response.text())
  }
  const registerToolGroup = (group: string, directory: string) => async (registration: ToolRegistration) => {
    const groups = registrations.get(registration.sessionId) ?? new Map<string, ToolRegistration>()
    groups.set(group, registration)
    registrations.set(registration.sessionId, groups)
    await request(`/api/session/${encodeURIComponent(registration.sessionId)}/tool`, {
      method: "POST",
      body: JSON.stringify({
        callbackUrl: registration.callbackUrl,
        tools: [...groups.values()].flatMap((value) => value.tools.map((tool) => ({
          ...tool,
          callbackUrl: value.callbackUrl,
        }))),
      }),
    }, directory)
  }
  const unregisterToolGroup = (group: string, directory: string) => async (sessionId: string) => {
    const groups = registrations.get(sessionId)
    groups?.delete(group)
    if (!groups?.size) {
      registrations.delete(sessionId)
      await request(`/api/session/${encodeURIComponent(sessionId)}/tool`, { method: "DELETE" }, directory)
      return
    }
    const remaining = [...groups.values()]
    await request(`/api/session/${encodeURIComponent(sessionId)}/tool`, {
      method: "POST",
      body: JSON.stringify({
        callbackUrl: remaining[0]!.callbackUrl,
        tools: remaining.flatMap((value) => value.tools.map((tool) => ({
          ...tool,
          callbackUrl: value.callbackUrl,
        }))),
      }),
    }, directory)
  }
  return {
    supportsConnections: !!options.connections,
    classifyAdmissionError: (error) => {
      if (!(error instanceof SessionV2RequestError)) return "indeterminate"
      if (error.pathname === "/api/session" && (error.status === 404 || error.status === 501)) return "unavailable"
      if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 425 && error.status !== 429)
        return "rejected"
      return "indeterminate"
    },
    admit: async (input) => {
      const messageId = `msg_workgraph_${input.attemptId}`
      const workspaceId = input.workspaceId ?? input.directory
      const created = await request(
        "/api/session",
        {
          method: "POST",
          body: JSON.stringify({
            ...(input.sessionId ? { id: input.sessionId } : {}),
            agent: input.profile.agent,
            model: {
              providerID: input.profile.model.providerId,
              id: input.profile.model.modelId,
              variant: input.profile.effort,
            },
            tools: input.profile.tools,
            location: { directory: input.directory },
          }),
        },
        input.directory,
      )
      const body = (await created.json()) as { id?: string; data?: { id?: string } }
      const adoptedId = body.id ?? body.data?.id
      if (!adoptedId) throw new Error("Session V2 create response did not include a Session ID")
      if (input.leaseEpoch !== undefined && options.executeAttempt) {
        const context = input.context
        if (!context) throw new Error("WorkGraph Attempt tools require the owner context")
        const bridge = WorkGraphAttemptToolRoutes({
          workspaceId,
          broker: (operation, signal) => options.executeAttempt!(context, operation, signal),
          registerSessionTools: registerToolGroup("attempt", input.directory),
          unregisterSessionTools: unregisterToolGroup("attempt", input.directory),
        })
        const registered = await bridge.request("/api/workgraph/attempt-binding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            identity: {
              attemptId: input.attemptId,
              sessionId: adoptedId,
              workspaceId,
              leaseEpoch: input.leaseEpoch,
            },
            brokerUrl: "http://127.0.0.1",
          }),
        })
        if (!registered.ok) {
          bridge.dispose()
          throw new Error(`Local Session Attempt binding failed: ${registered.status} ${await registered.text()}`)
        }
        attemptBridges.set(adoptedId, bridge)
      }
      if (input.profile.connectionIds.length > 0) {
        if (!options.connections) throw new Error("Connection-bound Attempts require the Connections service")
        const context = input.context
        if (!context) throw new Error("Connection-bound Attempts require the WorkGraph owner context")
        const ownerPartition = options.resolveTeamOwner(context)
        if (!ownerPartition) throw new Error("Connection-bound Attempts require an organization-owned Connection scope")
        const connectionTools = input.profile.tools.filter((tool) =>
          tool === "connection_work_source_list" || tool === "connection_work_source_comment" || tool === "connection_work_source_update")
        if (!connectionTools.length) throw new Error("Connection-bound Attempts require explicit Connection tools")
        const binding = {
          context,
          ownerPartition,
          attemptId: input.attemptId,
          sessionId: adoptedId,
          workspaceId,
          connectionIds: input.profile.connectionIds,
          tools: connectionTools,
        }
        const broker = createConnectionOperationBroker({
          bindings: { resolve: async () => binding },
          connections: createWorkGraphConnectionsPort({ service: options.connections, resolveTeamOwner: options.resolveTeamOwner }),
          ...(options.connectors ? { connectors: options.connectors } : {}),
        })
        const bridge = WorkGraphConnectionToolRoutes({
          workspaceId,
          broker: (operation) => broker.execute(operation.identity as never, operation.operation, {
            ownerUserId: context.ownerUserId,
            ownerPartition,
          }),
          registerSessionTools: registerToolGroup("connections", input.directory),
          unregisterSessionTools: unregisterToolGroup("connections", input.directory),
        })
        const registered = await bridge.request("/api/workgraph/connection-binding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            identity: { attemptId: input.attemptId, sessionId: adoptedId, workspaceId },
            connectionIds: input.profile.connectionIds,
            tools: connectionTools,
            brokerUrl: "http://127.0.0.1",
          }),
        })
        if (!registered.ok) {
          await request(`/api/session/${encodeURIComponent(adoptedId)}/interrupt`, { method: "POST" }, input.directory)
          throw new Error(`Local Session Connection binding failed: ${registered.status} ${await registered.text()}`)
        }
        bridges.set(adoptedId, bridge)
      }
      await request(
        `/api/session/${adoptedId}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({ id: messageId, prompt: { text: input.prompt }, delivery: "steer", resume: true }),
        },
        input.directory,
      )
      return adoptedId
    },
    cancel: async (sessionId) => {
      await request(`/api/session/${sessionId}/interrupt`, { method: "POST" })
      await cleanupBridge(bridges, sessionId, "/api/workgraph/connection-binding", "Connection")
      await cleanupBridge(attemptBridges, sessionId, "/api/workgraph/attempt-binding", "Attempt")
    },
    result: async (sessionId) => {
      const active = (await request("/api/session/active").then((response) => response.json())) as {
        data?: Record<string, unknown>
      }
      if (active.data?.[sessionId]) return { state: "running" }
      const events: SessionV2Event[] = []
      let after = 0
      for (;;) {
        const value = await request(`/api/session/${sessionId}/history?limit=100&after=${after}`).then((response) =>
          response.json())
        let page
        try {
          page = sessionHistoryPage(value)
        } catch (error) {
          if (!(error instanceof SessionHistoryResponseError)) throw error
          await cleanupBridge(bridges, sessionId, "/api/workgraph/connection-binding", "Connection")
          await cleanupBridge(attemptBridges, sessionId, "/api/workgraph/attempt-binding", "Attempt")
          return { state: "failed", message: error.code }
        }
        events.push(...page.data)
        if (!page.hasMore) break
        const next = page.data.at(-1)?.durable?.seq
        if (next === undefined || next <= after) {
          await cleanupBridge(bridges, sessionId, "/api/workgraph/connection-binding", "Connection")
          await cleanupBridge(attemptBridges, sessionId, "/api/workgraph/attempt-binding", "Attempt")
          return { state: "failed", message: "session_history_invalid" }
        }
        after = next
      }
      const settlement = events.findLast(
        (event) =>
          event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"),
      )
      if (!settlement) {
        const promoted = events.some((event) => event.type.startsWith("session.next.prompted"))
        return promoted
          ? { state: "failed", message: "Session stopped before the provider step settled" }
          : { state: "pending" }
      }
      await cleanupBridge(bridges, sessionId, "/api/workgraph/connection-binding", "Connection")
      await cleanupBridge(attemptBridges, sessionId, "/api/workgraph/attempt-binding", "Attempt")
      if (settlement.type.startsWith("session.next.step.failed")) {
        return { state: "failed", message: stringifySessionError(settlement.data.error) }
      }
      const summary = events.findLast((event) => event.type.startsWith("session.next.text.ended"))?.data.text
      if (typeof summary !== "string" || !summary.trim()) {
        return { state: "failed", message: "session_output_missing" }
      }
      const files = Array.isArray(settlement.data.files)
        ? settlement.data.files.filter((file): file is string => typeof file === "string" && !!file.trim())
        : []
      return {
        state: "succeeded",
        summary: summary.trim(),
        artifacts: files.map((file) => `file:${file.trim()}`),
      }
    },
  }
}

class HarnessSessionRequestError extends Error {
  constructor(readonly pathname: string, readonly status: number, body: string) {
    super(`Harness Session request failed: ${status} ${body}`)
  }
}

function classifySessionRequest(status: number) {
  if (status === 404 || status === 501 || status === 503) return "unavailable" as const
  if (status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) return "rejected" as const
  return "indeterminate" as const
}

function assistantSummary(input: unknown) {
  if (!Array.isArray(input)) return
  const assistant = input.findLast((message) => record(record(message)?.info)?.role === "assistant")
  const parts = record(assistant)?.parts
  if (!Array.isArray(parts)) return
  const text = parts.flatMap((part) => {
    const row = record(part)
    return row?.type === "text" && clean(row.text) ? [clean(row.text)!] : []
  }).join("\n").trim()
  return text || undefined
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function clean(input: unknown) {
  if (typeof input !== "string") return
  const value = input.trim()
  return value || undefined
}

class SessionV2RequestError extends Error {
  constructor(
    readonly pathname: string,
    readonly status: number,
    body: string,
  ) {
    super(`Session V2 request failed: ${status} ${body}`)
  }
}

async function cleanupBridge(
  bridges: Map<string, ReturnType<typeof WorkGraphConnectionToolRoutes> | ReturnType<typeof WorkGraphAttemptToolRoutes>>,
  sessionId: string,
  bindingPath: string,
  label: string,
) {
  const bridge = bridges.get(sessionId)
  if (!bridge) return
  const response = await bridge.request(`${bindingPath}/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  if (!response.ok) throw new Error(`Local Session ${label} cleanup failed: ${response.status} ${await response.text()}`)
  bridges.delete(sessionId)
}

type SessionV2Event = Readonly<{
  type: string
  durable?: Readonly<{ seq: number }>
  data: Readonly<Record<string, unknown>>
}>

class SessionHistoryResponseError extends Error {
  readonly code = "session_history_invalid"
}

function sessionHistoryPage(value: unknown): Readonly<{ data: SessionV2Event[]; hasMore: boolean }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionHistoryResponseError()
  const page = value as Record<string, unknown>
  if (!Array.isArray(page.data) || typeof page.hasMore !== "boolean") throw new SessionHistoryResponseError()
  const data = page.data.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionHistoryResponseError()
    const event = value as Record<string, unknown>
    if (typeof event.type !== "string" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
      throw new SessionHistoryResponseError()
    }
    if (event.durable !== undefined) {
      if (!event.durable || typeof event.durable !== "object" || Array.isArray(event.durable)) {
        throw new SessionHistoryResponseError()
      }
      const durable = event.durable as Record<string, unknown>
      if (typeof durable.seq !== "number" || !Number.isSafeInteger(durable.seq) || durable.seq < 1) {
        throw new SessionHistoryResponseError()
      }
    }
    return event as SessionV2Event
  })
  return { data, hasMore: page.hasMore }
}

function stringifySessionError(error: unknown) {
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  return JSON.stringify(error ?? "Session failed")
}
