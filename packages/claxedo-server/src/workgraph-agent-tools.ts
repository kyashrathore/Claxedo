import { z } from "zod"
import type { EmbeddedWorkGraphTransport } from "@claxedo/mcp/workgraph-tools"
import type { ExecutionProfileDefaults, WorkGraphContext } from "@claxedo/workgraph/contracts"
import type { LocalEmbeddedWorkGraph } from "./server-workgraph"
import { OPENCODE_INTERNAL_BASE, type OpenCodeApplicationToolRegistration, type OpenCodeRequestFn } from "./opencode-engine"

export function createLocalEmbeddedWorkGraphTransport(
  embedded: LocalEmbeddedWorkGraph,
  resolveContext: () => WorkGraphContext,
): EmbeddedWorkGraphTransport {
  const transport: EmbeddedWorkGraphTransport = {
    execute: (request) => embedded.service.execute(resolveContext(), request as never),
    snapshot: (input) => embedded.service.queries.snapshot.page(resolveContext(), input),
    readStream: (streamId) => embedded.service.queries.streams.read(resolveContext(), { streamId: streamId as never }),
    readDefaults: () => embedded.service.queries.defaults.read(resolveContext(), {}),
    listAttention: (input) => embedded.service.queries.attention.list(resolveContext(), input as never),
    listNotifications: (input) => embedded.notifications.list(resolveContext(), input as never),
    markNotificationRead: (notificationId, expectedVersion) =>
      embedded.notifications.markRead(resolveContext(), {
        id: notificationId as never,
        expectedVersion,
      }),
    listSources: (input) => embedded.service.queries.sources.list(resolveContext(), input as never),
    readSource: (workSourceId) =>
      embedded.service.queries.sources.read(resolveContext(), { workSourceId: workSourceId as never }),
    readSourceRevision: (workSourceId, revisionId) =>
      embedded.service.queries.sources.readRevision(resolveContext(), {
        workSourceId: workSourceId as never,
        revisionId: revisionId as never,
      }),
    readProposal: (proposalId) => embedded.service.queries.proposals.read(resolveContext(), { proposalId }),
    readWorkItem: (workItemId) => embedded.service.queries.workItems.readDetail(resolveContext(), { workItemId }),
    listWorkItemAttempts: (workItemId, input) =>
      embedded.service.queries.workItems.listAttempts(resolveContext(), {
        workItemId: workItemId as never,
        ...input,
      } as never),
    readAttempt: (attemptId) => embedded.service.queries.attempts.read(resolveContext(), { attemptId }),
    readDecision: (decisionId) => embedded.service.queries.decisions.read(resolveContext(), { decisionId }),
    readRecap: (recapId) => embedded.service.queries.recaps.read(resolveContext(), { recapId }),
    readEvidence: (evidenceId) =>
      embedded.service.queries.evidence.read(resolveContext(), { evidenceId: evidenceId as never }),
    listEvidence: (input) => embedded.service.queries.evidence.list(resolveContext(), input as never),
  }
  if (embedded.executionCapabilities) {
    Object.assign(transport, {
      readExecutionCapabilities: () => embedded.executionCapabilities!.read(resolveContext(), {}),
      ...(embedded.executionCapabilities.refresh
        ? {
            refreshExecutionCapabilities: () => embedded.executionCapabilities!.refresh!(resolveContext(), {}),
          }
        : {}),
    })
  }
  if (embedded.intake) {
    Object.assign(transport, {
      listSourceViews: async () => ({ sourceViews: await embedded.intake!.sourceViews.list(resolveContext()) }),
      createSourceView: (input: Readonly<Record<string, unknown>>) =>
        embedded.intake!.sourceViews.create(resolveContext(), input as never),
      updateSourceView: (sourceViewId: string, input: Readonly<Record<string, unknown>>) =>
        embedded.intake!.sourceViews.update(resolveContext(), sourceViewId, input as never),
      deleteSourceView: (sourceViewId: string, expectedVersion: number) =>
        embedded.intake!.sourceViews.delete(resolveContext(), sourceViewId, expectedVersion),
      refreshSourceView: (sourceViewId: string) => embedded.intake!.intake.refresh(resolveContext(), sourceViewId),
      listIntake: (input: Readonly<Record<string, unknown>>) =>
        embedded.intake!.intake.page(resolveContext(), input as never),
      readCandidate: (candidateId: string) => embedded.intake!.intake.read(resolveContext(), candidateId),
      stageCandidate: (candidateId: string) => embedded.intake!.intake.stage(resolveContext(), candidateId),
      dismissCandidate: (candidateId: string, expectedVersion: number) =>
        embedded.intake!.intake.dismiss(resolveContext(), candidateId, expectedVersion),
      restoreCandidate: (candidateId: string, expectedVersion: number) =>
        embedded.intake!.intake.restore(resolveContext(), candidateId, expectedVersion),
      syncCandidate: (
        candidateId: string,
        input: Readonly<{ idempotencyKey: string; summary: string; status?: string }>,
      ) => embedded.intake!.intake.syncExternal(resolveContext(), { candidateId, ...input }),
    })
  }
  return transport
}

export async function createLocalWorkGraphAgentTools(
  embedded: LocalEmbeddedWorkGraph,
  owner: Readonly<{
    organizationId: string
    ownerUserId: string
    sessionExecution?: (sessionId: string) => Promise<ExecutionProfileDefaults | undefined>
  }>,
): Promise<Readonly<Record<string, OpenCodeApplicationToolRegistration>>> {
  const { callWorkGraph, registerWorkGraphTools } = await import("@claxedo/mcp/workgraph-tools")
  const tools = new Map<string, Readonly<{ description: string; inputSchema: Record<string, z.ZodType> }>>()
  const context = (sessionID: string, toolCallID: string): WorkGraphContext => ({
    organizationId: owner.organizationId as never,
    ownerUserId: owner.ownerUserId as never,
    actor: { type: "agent", id: sessionID as never },
    requestId: `agent_tool_${toolCallID}_${crypto.randomUUID()}` as never,
    access: { mode: "owner" },
  })
  const probe = createLocalEmbeddedWorkGraphTransport(embedded, () => context("catalog", "catalog"))
  registerWorkGraphTools((name, config) => tools.set(name, config as never), probe, false)
  return Object.fromEntries(
    Array.from(tools, ([name, config]) => {
      const input = z.strictObject(config.inputSchema)
      return [
        name,
        {
          description: config.description,
          inputSchema: z.toJSONSchema(input) as Record<string, unknown>,
          execute: async (value: unknown, invocation: Readonly<{ sessionID: string; toolCallID: string }>) => {
            const execution = name === "workgraph_create_stream"
              ? await owner.sessionExecution?.(invocation.sessionID)
              : undefined
            return callWorkGraph(
              createLocalEmbeddedWorkGraphTransport(embedded, () =>
                context(invocation.sessionID, invocation.toolCallID),
              ),
              name as never,
              input.parse(value),
              execution ? { execution } : undefined,
            )
          },
        },
      ]
    }),
  )
}

export async function localSessionExecution(
  request: OpenCodeRequestFn,
  sessionId: string,
): Promise<ExecutionProfileDefaults | undefined> {
  const response = await request(new Request(`${OPENCODE_INTERNAL_BASE}/session/${encodeURIComponent(sessionId)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  }))
  if (!response.ok) throw new Error(`Unable to resolve Session ${sessionId} project context`)
  const session = await response.json() as unknown
  const directory = session && typeof session === "object" &&
    "id" in session && session.id === sessionId &&
    "directory" in session && typeof session.directory === "string"
    ? session.directory.trim()
    : undefined
  if (!directory) return undefined
  return {
    environment: { kind: "local_worktree", directory },
    repository: { baseRevision: "HEAD" },
  }
}
