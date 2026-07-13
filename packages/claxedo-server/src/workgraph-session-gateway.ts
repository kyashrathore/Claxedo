import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import type { ConnectionsService } from "@claxedo/connections"
import type { SourceIssueConnector } from "@claxedo/workgraph/connectors"
import { WorkGraphConnectionToolRoutes } from "@claxedo/workspace-runtime"
import { OPENCODE_INTERNAL_BASE } from "./opencode-engine"
import { createConnectionOperationBroker } from "./workgraph-host/connection-operation-broker"
import { createWorkGraphConnectionsPort } from "./workgraph-host/connections"
import type { WorkGraphSessionGateway } from "./workgraph-host/local-execution"

/** Session V2 transport used by the local embedded WorkGraph execution adapter. */
export function createSessionV2WorkGraphGateway(
  opencodeRequest: OpenCodeRequestFn,
  options: { connections?: ConnectionsService; connectors?: Readonly<Record<string, SourceIssueConnector>> } = {},
): WorkGraphSessionGateway {
  const bridges = new Map<string, ReturnType<typeof WorkGraphConnectionToolRoutes>>()
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
      if (input.profile.connectionIds.length > 0) {
        if (!options.connections) throw new Error("Connection-bound Attempts require the Connections service")
        const context = input.context
        if (!context) throw new Error("Connection-bound Attempts require the WorkGraph owner context")
        const connectionTools = input.profile.tools.filter((tool) =>
          tool === "connection_work_source_list" || tool === "connection_work_source_comment" || tool === "connection_work_source_update")
        if (!connectionTools.length) throw new Error("Connection-bound Attempts require explicit Connection tools")
        const binding = {
          context,
          ownerPartition: "local-team",
          attemptId: input.attemptId,
          sessionId: adoptedId,
          workspaceId: input.directory,
          connectionIds: input.profile.connectionIds,
          tools: connectionTools,
        }
        const broker = createConnectionOperationBroker({
          bindings: { resolve: async () => binding },
          connections: createWorkGraphConnectionsPort({ service: options.connections, resolveTeamOwner: () => undefined }),
          ...(options.connectors ? { connectors: options.connectors } : {}),
        })
        const bridge = WorkGraphConnectionToolRoutes({
          workspaceId: input.directory,
          broker: (operation) => broker.execute(operation.identity as never, operation.operation, {
            ownerUserId: context.ownerUserId,
            ownerPartition: "local-team",
          }),
          registerSessionTools: async (registration) => {
            await request(`/api/session/${encodeURIComponent(registration.sessionId)}/tool`, {
              method: "POST",
              body: JSON.stringify({ callbackUrl: registration.callbackUrl, tools: registration.tools }),
            }, input.directory)
          },
          unregisterSessionTools: async (sessionId) => {
            await request(`/api/session/${encodeURIComponent(sessionId)}/tool`, { method: "DELETE" }, input.directory)
          },
        })
        const registered = await bridge.request("/api/workgraph/connection-binding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            identity: { attemptId: input.attemptId, sessionId: adoptedId, workspaceId: input.directory },
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
      await cleanupBridge(bridges, sessionId)
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
          await cleanupBridge(bridges, sessionId)
          return { state: "failed", message: error.code }
        }
        events.push(...page.data)
        if (!page.hasMore) break
        const next = page.data.at(-1)?.durable?.seq
        if (next === undefined || next <= after) {
          await cleanupBridge(bridges, sessionId)
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
      await cleanupBridge(bridges, sessionId)
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
  bridges: Map<string, ReturnType<typeof WorkGraphConnectionToolRoutes>>,
  sessionId: string,
) {
  const bridge = bridges.get(sessionId)
  if (!bridge) return
  const response = await bridge.request(`/api/workgraph/connection-binding/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  if (!response.ok) throw new Error(`Local Session Connection cleanup failed: ${response.status} ${await response.text()}`)
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
