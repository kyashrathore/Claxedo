import type { ConnectionCapabilityHandle, ConnectionsPort, LiveConnectionAuthorization } from "../ports"
import { hashWorkSourceContent } from "./work-source-service"
import { createSourceAdmissionService, type AdmissionCommandGateway } from "./source-admission-service"
import { WorkGraphConnectionToolNames } from "../contracts"
import type {
  AdmissionProposalID,
  IntakeCandidateListInput,
  IntakeCandidatePage,
  IntakeCandidateDto,
  OperationID,
  WorkGraphContext,
  WorkSourceRevisionRef,
} from "../contracts"
import {
  SourceIssueUnauthorizedError,
  type SourceIssue,
  type SourceIssueConnector,
} from "../connectors/interface"
import { providerMatchesIntegration, type SourceProvider, type SourceView, type SourceViewStore } from "./source-view-service"

export type ExternalIntakeCandidate = Readonly<Extract<IntakeCandidateDto, { candidateKind: "external_issue" }>>
export type SessionIntakeCandidate = Readonly<Extract<IntakeCandidateDto, { candidateKind: "session" }>>
export type IntakeCandidate = Readonly<IntakeCandidateDto>

export type IntakeCandidateStore = Readonly<{
  upsertExternal(
    context: WorkGraphContext,
    input: Readonly<{ candidate: ExternalIntakeCandidate; identityKey: string }>,
  ): Promise<Readonly<{ candidate: ExternalIntakeCandidate; created: boolean }>>
  read(context: WorkGraphContext, id: string): Promise<IntakeCandidate | undefined>
  list(context: WorkGraphContext, sourceViewId?: string): Promise<readonly IntakeCandidate[]>
  page(context: WorkGraphContext, input: IntakeCandidateListInput): Promise<IntakeCandidatePage>
  prepareStage(
    context: WorkGraphContext,
    id: string,
    draft: Readonly<{ title: string; content: string }>,
  ): Promise<Readonly<{ candidate: IntakeCandidate; draft: Readonly<{ title: string; content: string }> }>>
  stage(
    context: WorkGraphContext,
    id: string,
    input: Readonly<{ source: WorkSourceRevisionRef; proposalId: AdmissionProposalID }>,
  ): Promise<IntakeCandidate>
  transition(
    context: WorkGraphContext,
    id: string,
    input: Readonly<{
      expectedVersion: number
      from: "unorganized" | "dismissed"
      to: "dismissed" | "unorganized"
      updatedAt: number
    }>,
  ): Promise<
    | Readonly<{ ok: true; candidate: IntakeCandidate }>
    | Readonly<{ ok: false; reason: "not_found" | "version_conflict" | "invalid_state" }>
  >
}>

export type IntakeReceiptStore = Readonly<{
  begin(
    context: WorkGraphContext,
    input: Readonly<{ key: string; candidateId: string; effect: "announce" | "full" }>,
  ): Promise<Readonly<{ state: "completed" } | { state: "busy" } | { state: "acquired"; leaseId: string }>>
  complete(context: WorkGraphContext, input: Readonly<{ key: string; leaseId: string }>): Promise<void>
  fail(context: WorkGraphContext, input: Readonly<{ key: string; leaseId: string }>): Promise<void>
}>

export type SourceIssueConnectorRegistry = Readonly<{
  get(provider: SourceProvider): SourceIssueConnector | undefined
}>

export function createIntakeService(input: Readonly<{
  sourceViews: SourceViewStore
  candidates: IntakeCandidateStore
  receipts: IntakeReceiptStore
  commands: AdmissionCommandGateway
  connections: ConnectionsPort
  connectors: SourceIssueConnectorRegistry
  ids: Readonly<{ next: () => string }>
  clock?: Readonly<{ now: () => number }>
}>) {
  const clock = input.clock ?? { now: Date.now }
  const admissions = createSourceAdmissionService(input.commands)

  return {
    async refresh(context: WorkGraphContext, sourceViewId: string) {
      requireOwner(context)
      const sourceView = await requireSourceView(input.sourceViews, context, sourceViewId)
      if (sourceView.status !== "active") return { created: 0, updated: 0, candidates: [] }
      const connector = requireConnector(input.connectors, sourceView.provider)
      const handle = await resolveHandle(input.connections, context, sourceView)
      const result = await useAuthorization(handle, () => connector.provider, (authorization) => connector.list(authorization, {
        providerUserId: sourceView.providerUserId,
        filters: sourceView.filters,
      }))
      const saved = await Promise.all(result.issues.map((issue) => upsertIssue(input, context, sourceView, issue, clock.now())))
      return {
        created: saved.filter((entry) => entry.created).length,
        updated: saved.filter((entry) => !entry.created).length,
        candidates: saved.map((entry) => entry.candidate),
      }
    },

    read: (context: WorkGraphContext, candidateId: string) => input.candidates.read(context, candidateId),

    list: (context: WorkGraphContext, sourceViewId?: string) => input.candidates.list(context, sourceViewId),

    page: (context: WorkGraphContext, request: IntakeCandidateListInput) => input.candidates.page(context, request),

    dismiss: (context: WorkGraphContext, candidateId: string, expectedVersion: number) => transitionCandidate(
      input.candidates,
      clock,
      context,
      candidateId,
      expectedVersion,
      "unorganized",
      "dismissed",
    ),

    restore: (context: WorkGraphContext, candidateId: string, expectedVersion: number) => transitionCandidate(
      input.candidates,
      clock,
      context,
      candidateId,
      expectedVersion,
      "dismissed",
      "unorganized",
    ),

    async stage(context: WorkGraphContext, candidateId: string) {
      requireOwner(context)
      const candidate = await input.candidates.read(context, candidateId)
      if (!candidate) throw new IntakeStateError("Candidate not found")
      if (candidate.state !== "unorganized" && candidate.state !== "staged") throw new IntakeStateError("Candidate cannot be staged")
      if (candidate.source && candidate.admissionProposalId) return candidate
      const prepared = await input.candidates.prepareStage(context, candidate.id, {
        title: candidate.title,
        content: intakeSourceDocument(candidate),
      })
      const sourceResult = await input.commands.execute(context, {
        operationId: `intake:${context.ownerUserId}:${candidate.id}:source` as OperationID,
        command: { version: 1, type: "create_work_source", ...prepared.draft },
      })
      if (!sourceResult.ok) throw new IntakeStateError(sourceResult.error.message)
      const workSourceId = commandValue(sourceResult.value, "workSourceId")
      const revisionId = commandValue(sourceResult.value, "revisionId")
      const source = {
        workSourceId,
        revisionId,
        contentHash: hashWorkSourceContent(prepared.draft.content),
      } as WorkSourceRevisionRef
      const proposalResult = await admissions.propose(context, {
        operationId: `intake:${context.ownerUserId}:${candidate.id}:proposal` as OperationID,
        source,
        ...(candidate.candidateKind === "session" && candidate.execution
          ? { execution: candidate.execution }
          : candidate.candidateKind === "external_issue"
            ? await sourceViewExecution(input.sourceViews, input.connections, context, candidate.sourceViewId)
            : {}),
      })
      if (!proposalResult.ok) throw new IntakeStateError(proposalResult.error.message)
      return input.candidates.stage(context, candidate.id, {
        source,
        proposalId: commandValue(proposalResult.value, "proposalId") as AdmissionProposalID,
      })
    },

    async syncExternal(context: WorkGraphContext, request: Readonly<{
      candidateId: string
      idempotencyKey: string
      summary: string
      status?: string
    }>) {
      requireOwner(context)
      const candidate = await input.candidates.read(context, request.candidateId)
      if (!candidate) throw new IntakeStateError("Candidate not found")
      if (candidate.candidateKind !== "external_issue") throw new IntakeStateError("Only external candidates can sync to a provider")
      if (candidate.state !== "confirmed") throw new IntakeStateError("Only a confirmed candidate can sync externally")
      const sourceView = await requireSourceView(input.sourceViews, context, candidate.sourceViewId)
      if (sourceView.syncPolicy === "silent") return { applied: false, reason: "silent_policy" as const }
      const effect = sourceView.syncPolicy === "announce" ? "announce" as const : "full" as const
      const receipt = await input.receipts.begin(context, {
        key: required(request.idempotencyKey, "idempotencyKey"),
        candidateId: candidate.id,
        effect,
      })
      if (receipt.state === "completed") return { applied: false, reason: "already_applied" as const }
      if (receipt.state === "busy") return { applied: false, reason: "in_progress" as const }
      const connector = requireConnector(input.connectors, sourceView.provider)
      const handle = await resolveHandle(input.connections, context, sourceView)
      try {
        await useAuthorization(handle, () => connector.provider, async (authorization) => {
          if (effect === "announce") {
            await connector.comment(authorization, { externalId: candidate.externalId, body: request.summary, idempotencyKey: request.idempotencyKey })
            return
          }
          await connector.update(authorization, {
            externalId: candidate.externalId,
            ...(request.status ? { status: request.status } : {}),
            body: request.summary,
            idempotencyKey: request.idempotencyKey,
          })
        })
        await input.receipts.complete(context, { key: request.idempotencyKey, leaseId: receipt.leaseId })
      } catch (error) {
        await input.receipts.fail(context, { key: request.idempotencyKey, leaseId: receipt.leaseId })
        throw error
      }
      return { applied: true, reason: effect }
    },
  }
}

async function sourceViewExecution(
  store: SourceViewStore,
  connections: ConnectionsPort,
  context: WorkGraphContext,
  sourceViewId: string,
) {
  const sourceView = await requireSourceView(store, context, sourceViewId)
  if (!sourceView.target) throw new IntakeStateError("Source view requires a Stream target before admission")
  const codeHost = await connections.resolveCapabilities(context, {
    connectionIds: [sourceView.teamConnectionId],
    capability: "code-host",
  })
  return {
    execution: {
      ...sourceView.target,
      connectionIds: [sourceView.teamConnectionId],
      tools: WorkGraphConnectionToolNames.filter((tool) =>
        tool !== "connection_code_host_open_pr" || codeHost.some((handle) => handle.id === sourceView.teamConnectionId)),
    },
  }
}

function intakeSourceDocument(candidate: IntakeCandidate) {
  const evidence = candidate.candidateKind === "external_issue"
    ? {
        candidateKind: candidate.candidateKind,
        candidateId: candidate.id,
        sourceViewId: candidate.sourceViewId,
        provider: candidate.provider,
        externalId: candidate.externalId,
        ...(candidate.externalKey ? { externalKey: candidate.externalKey } : {}),
        ...(candidate.externalUrl ? { externalUrl: candidate.externalUrl } : {}),
        externalStatus: candidate.externalStatus,
        ...(candidate.observedRevision ? { observedRevision: candidate.observedRevision } : {}),
      }
    : {
        candidateKind: candidate.candidateKind,
        candidateId: candidate.id,
        sessionId: candidate.sessionId,
        ...(candidate.observedRevision ? { observedRevision: candidate.observedRevision } : {}),
      }
  return `# ${candidate.title}\n\n${candidate.body}\n\n## WorkGraph intake evidence\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\``
}

function commandValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value) || typeof value[key as keyof typeof value] !== "string") {
    throw new IntakeStateError(`WorkGraph command did not return ${key}`)
  }
  return value[key as keyof typeof value] as string
}

export class IntakeStateError extends Error {
  readonly code = "intake_candidate_state_conflict" as const
}
export class IntakeCandidateNotFoundError extends Error {
  readonly code = "intake_candidate_not_found" as const
  constructor() {
    super("Candidate not found")
  }
}
export class IntakeCandidateVersionConflictError extends Error {
  readonly code = "intake_candidate_version_conflict" as const
  constructor() {
    super("Candidate version changed")
  }
}
export class IntakeConnectionError extends Error {}

async function upsertIssue(
  input: Parameters<typeof createIntakeService>[0],
  context: WorkGraphContext,
  sourceView: SourceView,
  issue: SourceIssue,
  now: number,
) {
  const candidate: IntakeCandidate = {
    candidateKind: "external_issue",
    id: input.ids.next(),
    ownerUserId: context.ownerUserId,
    version: 1,
    sourceViewId: sourceView.id,
    provider: sourceView.provider,
    externalId: required(issue.externalId, "externalId"),
    ...(issue.externalKey ? { externalKey: issue.externalKey } : {}),
    ...(issue.externalUrl ? { externalUrl: issue.externalUrl } : {}),
    title: required(issue.title, "title"),
    body: issue.body,
    externalStatus: issue.status,
    ...(issue.revision ? { observedRevision: issue.revision } : {}),
    state: "unorganized",
    createdAt: now,
    updatedAt: now,
  }
  return input.candidates.upsertExternal(context, {
    candidate,
    identityKey: `${context.ownerUserId}:${sourceView.provider}:${sourceView.teamConnectionId}:${candidate.externalId}`,
  })
}

async function transitionCandidate(
  store: IntakeCandidateStore,
  clock: Readonly<{ now: () => number }>,
  context: WorkGraphContext,
  candidateId: string,
  expectedVersion: number,
  from: "unorganized" | "dismissed",
  to: "dismissed" | "unorganized",
) {
  requireOwner(context)
  if (!candidateId.trim()) throw new IntakeCandidateNotFoundError()
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new IntakeCandidateVersionConflictError()
  const result = await store.transition(context, candidateId, { expectedVersion, from, to, updatedAt: clock.now() })
  if (result.ok) return result.candidate
  if (result.reason === "not_found") throw new IntakeCandidateNotFoundError()
  if (result.reason === "version_conflict") throw new IntakeCandidateVersionConflictError()
  throw new IntakeStateError(`Candidate must be ${from} before it can become ${to}`)
}

async function requireSourceView(store: SourceViewStore, context: WorkGraphContext, id: string) {
  const sourceView = await store.read(context, id)
  if (!sourceView) throw new IntakeStateError("Source view not found")
  return sourceView
}

function requireConnector(registry: SourceIssueConnectorRegistry, provider: SourceProvider) {
  const connector = registry.get(provider)
  if (!connector) throw new IntakeConnectionError(`No ${provider} source connector is configured`)
  return connector
}

async function resolveHandle(connections: ConnectionsPort, context: WorkGraphContext, sourceView: SourceView) {
  const [handle] = await connections.resolveCapabilities(context, {
    connectionIds: [sourceView.teamConnectionId],
    capability: "work-source",
  })
  if (!handle || handle.id !== sourceView.teamConnectionId || handle.scope !== "team" || !providerMatchesIntegration(sourceView.provider, handle.integrationId)) {
    throw new IntakeConnectionError("The source view connection is unavailable")
  }
  return handle
}

async function useAuthorization<Result>(
  handle: ConnectionCapabilityHandle,
  provider: () => string,
  use: (authorization: LiveConnectionAuthorization) => Promise<Result>,
) {
  try {
    return await handle.withAuthorization(use)
  } catch (error) {
    if (error instanceof SourceIssueUnauthorizedError) {
      await handle.reportAuthFailure(`${provider()}_401`)
      throw error
    }
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      await handle.reportAuthFailure(`${provider()}_401`)
      throw new SourceIssueUnauthorizedError(provider())
    }
    throw error
  }
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new IntakeStateError("Owner access is required")
}

function required(value: string, name: string) {
  const result = value.trim()
  if (!result) throw new IntakeStateError(`${name} is required`)
  return result
}
