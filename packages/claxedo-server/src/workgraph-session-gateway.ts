import path from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import type { ConnectionsService } from "@claxedo/connections"
import type { CodeHostConnector, SourceIssueConnector } from "@claxedo/workgraph/connectors"
import { WorkGraphRunToolRoutes, WorkGraphConnectionToolRoutes } from "@claxedo/workspace-runtime"
import {
  WorkGraphRunIdentitySchema,
  WorkGraphRunToolNames,
  type CommandResult,
  type WorkGraphConnectionOperationResponse,
  type WorkGraphRunOperationRequest,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import { OPENCODE_INTERNAL_BASE } from "./opencode/engine"
import { ConnectionOperationDeniedError, createConnectionOperationBroker } from "./hosts/workgraph/connection-operation-broker"
import { createWorkGraphConnectionsPort } from "./hosts/workgraph/connections"
import type { WorkGraphSessionGateway } from "./hosts/workgraph/local-execution"
import {
  registerWorkGraphSessionAttribution,
  unregisterWorkGraphSessionAttribution,
} from "./telemetry/metering"

type SessionV2WorkGraphGatewayOptions = (Readonly<{
  connections?: undefined
  connectors?: Readonly<Record<string, SourceIssueConnector>>
  codeHostConnectors?: Readonly<Record<string, CodeHostConnector>>
}> | Readonly<{
  connections: ConnectionsService
  connectors?: Readonly<Record<string, SourceIssueConnector>>
  codeHostConnectors?: Readonly<Record<string, CodeHostConnector>>
  resolveTeamOwner(context: WorkGraphContext): string | undefined
}>) & Readonly<{
  executeRun?: (
    context: WorkGraphContext,
    request: WorkGraphRunOperationRequest,
    signal: AbortSignal,
  ) => Promise<CommandResult>
  runContexts?: Readonly<{
    bind(input: Readonly<{
      identity: WorkGraphRunOperationRequest["identity"]
      context: WorkGraphContext
    }>): Promise<void>
    release(sessionId: string): Promise<void>
  }>
  recordPullRequest?: (
    context: WorkGraphContext,
    input: Readonly<{
      streamId: string
      runId: string
      idempotencyKey: string
      pullRequestId: string
      url: string
      draft: boolean
    }>,
  ) => Promise<Readonly<{ durableEffectReceiptId: string; evidenceId?: string }>>
  authorizePullRequest?: (
    context: WorkGraphContext,
    input: Readonly<{ streamId: string; repository: string; title: string; draft: boolean; publicRepository: boolean }>,
  ) => Promise<boolean>
  pullRequestEffects?: Readonly<{
    claim(
      context: WorkGraphContext,
      input: Readonly<{
        streamId: string
        runId: string
        idempotencyKey: string
        repository: string
        head: string
        base: string
        title: string
        body?: string
        draft: boolean
        publicRepository: boolean
      }>,
    ): Promise<
      | Readonly<{ state: "claimed"; outboxId: string; leaseId: string }>
      | Readonly<{ state: "completed"; result: Extract<WorkGraphConnectionOperationResponse, { type: "open_pull_request" }> }>
      | Readonly<{ state: "busy" | "failed" }>
    >
    complete(
      context: WorkGraphContext,
      input: Readonly<{
        outboxId: string
        leaseId: string
        result: Extract<WorkGraphConnectionOperationResponse, { type: "open_pull_request" }>
      }>,
    ): Promise<Extract<WorkGraphConnectionOperationResponse, { type: "open_pull_request" }>>
    fail(context: WorkGraphContext, input: Readonly<{ outboxId: string; leaseId: string }>): Promise<void>
  }>
}>

export type WorkGraphSessionBinding = Readonly<{
  runId: string
  sessionId: string
  runtimeSessionId?: string
  directory: string
  harness: string
  workspaceId?: string
  generation?: number
  baseCommit?: string
}>

export type WorkGraphSessionBindingStore = Readonly<{
  all(): Promise<readonly WorkGraphSessionBinding[]>
  findByRun(runId: string): Promise<WorkGraphSessionBinding | undefined>
  findBySession(sessionId: string): Promise<WorkGraphSessionBinding | undefined>
  save(binding: WorkGraphSessionBinding): Promise<void>
  deleteByRun?(runId: string): Promise<void>
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
      const runId = clean(row?.runId)
      const sessionId = clean(row?.sessionId)
      const runtimeSessionId = clean(row?.runtimeSessionId)
      const directory = clean(row?.directory)
      const harness = clean(row?.harness)
      const workspaceId = clean(row?.workspaceId)
      const baseCommit = clean(row?.baseCommit)
      const generation = typeof row?.generation === "number" && Number.isInteger(row.generation)
        ? row.generation
        : undefined
      if (!runId || !sessionId || !directory || !harness) {
        throw new Error("WorkGraph Session binding index contains an invalid binding")
      }
      return {
        runId,
        sessionId,
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
        directory,
        harness,
        ...(workspaceId ? { workspaceId } : {}),
        ...(generation !== undefined ? { generation } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      }
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
    findByRun: async (runId) => (await read()).find((binding) => binding.runId === runId),
    findBySession: async (sessionId) => (await read()).find((binding) => binding.sessionId === sessionId),
    save: async (binding) => update((bindings) => [
      ...bindings.filter((item) => item.runId !== binding.runId && item.sessionId !== binding.sessionId),
      binding,
    ]),
    deleteByRun: async (runId) => update((bindings) => {
      const next = bindings.filter((binding) => binding.runId !== runId)
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
    findByRun: async (runId: string) => memory.get(runId),
    findBySession: async (sessionId: string) => [...memory.values()].find((binding) => binding.sessionId === sessionId),
    save: async (binding: WorkGraphSessionBinding) => { memory.set(binding.runId, binding) },
    deleteByRun: async (runId: string) => { memory.delete(runId) },
    deleteByDirectory: async (directory: string) => {
      for (const [runId, binding] of memory) {
        if (binding.directory === directory) memory.delete(runId)
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
  const cleanupRunBinding = async (binding: WorkGraphSessionBinding) => {
    unregisterWorkGraphSessionAttribution(binding.sessionId)
    if (!options.runContexts) return
    const cleanup = await Promise.allSettled([
      request(binding, `/api/workgraph/run-binding/${encodeURIComponent(binding.sessionId)}`, { method: "DELETE" }),
      options.runContexts.release(binding.sessionId),
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
        throw new Error("Connection-bound Runs currently require the OpenCode harness")
      }
      if (input.generation !== undefined && options.executeRun) {
        if (!input.context) throw new Error("WorkGraph Run tools require the owner context")
        if (!options.runContexts) throw new Error("WorkGraph Run tools require a trusted local context registry")
      }
      const existing = await bindings.findByRun(input.runId)
      if (
        existing
        && (
          existing.directory !== input.directory
          || (existing.workspaceId && existing.workspaceId !== input.workspaceId)
          || (existing.generation !== undefined && existing.generation !== input.generation)
          || (existing.baseCommit && existing.baseCommit !== input.baseCommit)
        )
      ) throw new Error(`WorkGraph Run ${input.runId} is already admitted with different workspace placement`)
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
          runId: input.runId,
          sessionId: input.sessionId ?? runtimeSessionId,
          ...(input.sessionId && input.sessionId !== runtimeSessionId ? { runtimeSessionId } : {}),
          directory: input.directory,
          harness: input.profile.harness,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
        }
        await bindings.save(next)
        return next
      })()
      try {
        if (input.generation !== undefined && options.executeRun) {
          const identity = WorkGraphRunIdentitySchema.parse({
            runId: input.runId,
            streamId: input.streamId,
            sessionId: binding.sessionId,
            workspaceId: input.workspaceId ?? input.directory,
            generation: input.generation,
          })
          await options.runContexts!.bind({ identity, context: input.context! }).catch(async (error) => {
            await bindings.deleteByRun?.(input.runId)
            throw error
          })
          await request(binding, "/api/workgraph/run-binding", {
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
            messageID: `msg_workgraph_${input.runId}`,
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
            cleanupRunBinding(binding),
            bindings.deleteByRun?.(input.runId),
          ])
        }
        throw error
      }
      registerWorkGraphSessionAttribution(binding.sessionId, {
        streamId: input.streamId,
        runId: input.runId,
        workItemId: input.workItemId,
      })
      return binding.sessionId
    },
    cancel: async (sessionId, reason) => {
      const binding = await bindings.findBySession(sessionId)
      if (!binding) return v2.cancel(sessionId, reason)
      const results = await Promise.allSettled([
        request(binding, `/session/${encodeURIComponent(runtimeSessionId(binding))}/abort`, { method: "POST" }),
        cleanupRunBinding(binding),
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
        await cleanupRunBinding(binding)
        return { state: "failed", message: clean(lastTurn.error) ?? "Harness Session failed" }
      }
      if (lastTurn?.status === "cancelled") {
        await cleanupRunBinding(binding)
        return { state: "cancelled" }
      }
      if (lastTurn?.status !== "completed") return { state: "pending" }
      await cleanupRunBinding(binding)
      const messages = await request(binding, `/session/${encodeURIComponent(runtimeId)}/message`).then((response) => response.json())
      const summary = assistantSummary(messages)
      if (!summary) return { state: "failed", message: "session_output_missing" }
      return { state: "succeeded", summary, artifacts: [] }
    },
    releaseDirectory: async (directory) => {
      const cleanup = await Promise.allSettled(
        (await bindings.all()).filter((binding) => binding.directory === directory).map(cleanupRunBinding),
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
  const runBridges = new Map<string, ReturnType<typeof WorkGraphRunToolRoutes>>()
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
  const cleanupSession = async (sessionId: string) => {
    try {
      await cleanupBridge(bridges, sessionId, "/api/workgraph/connection-binding", "Connection")
      await cleanupBridge(runBridges, sessionId, "/api/workgraph/run-binding", "Run")
    } finally {
      unregisterWorkGraphSessionAttribution(sessionId)
    }
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
      const messageId = input.messageId ?? `msg_workgraph_${input.runId}`
      const workspaceId = input.workspaceId ?? input.directory
      const created = await request(
        "/api/session",
        {
          method: "POST",
          body: JSON.stringify({
            ...(input.sessionId ? { id: input.sessionId } : {}),
            title: input.title,
            agent: input.profile.agent,
            model: {
              providerID: input.profile.model.providerId,
              id: input.profile.model.modelId,
              variant: input.profile.effort,
            },
            tools: [
              ...input.profile.tools,
              ...(input.generation !== undefined && options.executeRun ? WorkGraphRunToolNames : []),
            ].filter((tool, index, tools) => tools.indexOf(tool) === index),
            location: { directory: input.directory },
          }),
        },
        input.directory,
      )
      const body = (await created.json()) as { id?: string; data?: { id?: string } }
      const adoptedId = body.id ?? body.data?.id
      if (!adoptedId) throw new Error("Session V2 create response did not include a Session ID")
      await cleanupBridge(runBridges, adoptedId, "/api/workgraph/run-binding", "Run")
      await cleanupBridge(bridges, adoptedId, "/api/workgraph/connection-binding", "Connection")
      if (input.generation !== undefined && options.executeRun) {
        const context = input.context
        if (!context) throw new Error("WorkGraph Run tools require the owner context")
        const bridge = WorkGraphRunToolRoutes({
          workspaceId,
          broker: (operation, signal) => options.executeRun!(context, operation, signal),
          registerSessionTools: registerToolGroup("run", input.directory),
          unregisterSessionTools: unregisterToolGroup("run", input.directory),
        })
        const registered = await bridge.request("/api/workgraph/run-binding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            identity: {
              runId: input.runId,
              streamId: input.streamId,
              sessionId: adoptedId,
              workspaceId,
              generation: input.generation,
            },
            brokerUrl: "http://127.0.0.1",
          }),
        })
        if (!registered.ok) {
          bridge.dispose()
          throw new Error(`Local Session Run binding failed: ${registered.status} ${await registered.text()}`)
        }
        runBridges.set(adoptedId, bridge)
      }
      if (input.profile.connectionIds.length > 0) {
        if (!options.connections) throw new Error("Connection-bound Runs require the Connections service")
        const context = input.context
        if (!context) throw new Error("Connection-bound Runs require the WorkGraph owner context")
        const ownerPartition = options.resolveTeamOwner(context)
        if (!ownerPartition) throw new Error("Connection-bound Runs require an organization-owned Connection scope")
        const connectionTools = input.profile.tools.filter((tool) =>
          tool === "connection_work_source_list" || tool === "connection_work_source_comment" || tool === "connection_work_source_update" ||
          tool === "connection_code_host_open_pr")
        if (!connectionTools.length) throw new Error("Connection-bound Runs require explicit Connection tools")
        const binding = {
          context,
          ownerPartition,
          runId: input.runId,
          sessionId: adoptedId,
          workspaceId,
          connectionIds: input.profile.connectionIds,
          tools: connectionTools,
        }
        const operationBroker = createConnectionOperationBroker({
          bindings: { resolve: async () => binding },
          connections: createWorkGraphConnectionsPort({ service: options.connections, resolveTeamOwner: options.resolveTeamOwner }),
          ...(options.connectors ? { connectors: options.connectors } : {}),
          ...(options.codeHostConnectors ? { codeHostConnectors: options.codeHostConnectors } : {}),
        })
        const bridge = WorkGraphConnectionToolRoutes({
          workspaceId,
          broker: async (operation) => {
            const pullRequest = operation.operation.type === "open_pull_request" ? operation.operation : undefined
            let verifiedPublicRepository = false
            if (pullRequest) {
              // Fail closed: a PR may only be opened when the full receipt
              // pipeline is present. Missing streamId or deps must never
              // silently skip the confirmation gate or the effect ledger.
              if (!input.streamId || !options.authorizePullRequest || !options.pullRequestEffects || !options.recordPullRequest) {
                throw new ConnectionOperationDeniedError("Pull request delivery requires a Stream-bound receipt pipeline")
              }
              // The confirmation gate keys on provider-verified visibility,
              // never the agent-supplied flag. Drafts skip the lookup (the
              // gate only guards non-draft PRs); lookup failure reads as
              // public, which forces confirmation.
              verifiedPublicRepository = pullRequest.draft
                ? false
                : await operationBroker
                    .repositoryVisibility(operation.identity as never, pullRequest.repository, {
                      ownerUserId: context.ownerUserId,
                      ownerPartition,
                    })
                    .then((visibility) => visibility === "public")
                    .catch(() => true)
              const authorized = await options.authorizePullRequest(context, {
                streamId: input.streamId,
                repository: pullRequest.repository,
                title: pullRequest.title,
                draft: pullRequest.draft,
                publicRepository: verifiedPublicRepository,
              })
              if (!authorized) throw new ConnectionOperationDeniedError("The first non-draft public pull request requires owner confirmation")
            }
            const effect = pullRequest && input.streamId && options.pullRequestEffects
              ? await options.pullRequestEffects.claim(context, {
                  streamId: input.streamId,
                  runId: input.runId,
                  idempotencyKey: pullRequest.idempotencyKey,
                  repository: pullRequest.repository,
                  head: pullRequest.head,
                  base: pullRequest.base,
                  title: pullRequest.title,
                  ...(pullRequest.body === undefined ? {} : { body: pullRequest.body }),
                  draft: pullRequest.draft,
                  publicRepository: verifiedPublicRepository,
                })
              : undefined
            if (effect?.state === "completed") return effect.result
            if (effect?.state === "busy") throw new Error("Pull request delivery is already in progress")
            if (effect?.state === "failed") throw new Error("Pull request delivery halted after repeated provider failure")
            const result = await operationBroker.execute(operation.identity as never, operation.operation, {
              ownerUserId: context.ownerUserId,
              ownerPartition,
            }).catch(async (error) => {
              if (effect?.state === "claimed" && options.pullRequestEffects) {
                await options.pullRequestEffects.fail(context, effect)
              }
              throw error
            })
            if (result.type !== "open_pull_request") return result
            if (!input.streamId || !options.recordPullRequest || !pullRequest) {
              throw new Error("Pull request receipt persistence is unavailable")
            }
            const recorded = {
              ...result,
              ...await options.recordPullRequest(context, {
                streamId: input.streamId,
                runId: input.runId,
                idempotencyKey: pullRequest.idempotencyKey,
                pullRequestId: result.pullRequestId,
                url: result.url,
                draft: result.draft,
              }),
            }
            if (effect?.state !== "claimed" || !options.pullRequestEffects) return recorded
            return options.pullRequestEffects.complete(context, { ...effect, result: recorded })
          },
          registerSessionTools: registerToolGroup("connections", input.directory),
          unregisterSessionTools: unregisterToolGroup("connections", input.directory),
        })
        const registered = await bridge.request("/api/workgraph/connection-binding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            identity: { runId: input.runId, sessionId: adoptedId, workspaceId },
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
      registerWorkGraphSessionAttribution(adoptedId, {
        streamId: input.streamId,
        runId: input.runId,
        workItemId: input.workItemId,
      })
      return adoptedId
    },
    cancel: async (sessionId) => {
      await request(`/api/session/${sessionId}/interrupt`, { method: "POST" })
      await cleanupSession(sessionId)
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
          await cleanupSession(sessionId)
          return { state: "failed", message: error.code }
        }
        events.push(...page.data)
        if (!page.hasMore) break
        const next = page.data.at(-1)?.durable?.seq
        if (next === undefined || next <= after) {
          await cleanupSession(sessionId)
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
          ? { state: "parked", message: "Session stopped before the provider step settled" }
          : { state: "pending" }
      }
      await cleanupSession(sessionId)
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
  bridges: Map<string, ReturnType<typeof WorkGraphConnectionToolRoutes> | ReturnType<typeof WorkGraphRunToolRoutes>>,
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
