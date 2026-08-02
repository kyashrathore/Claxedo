import {
  AdmissionProposalIDSchema,
  AuthoringSourceRevisionSchema,
  ContentHashSchema,
  OperationIDSchema,
  StreamIDSchema,
  WorkSourceIDSchema,
  WorkSourceRevisionIDSchema,
  WorkSourceRevisionRefSchema,
  type CommandResult,
  type WorkSourceDto,
  type WorkSourceRevisionDto,
} from "@claxedo/workgraph/contracts"
import {
  DocumentSnapshotForWorkSchema,
  type DocumentSnapshotForWork,
  DocumentWorkSourceRequestSchema,
  type DocumentWorkSourceRequest,
} from "@/features/documents/actions/doc-actions"
import { createWorkGraphClient, type WorkGraphClient } from "@/features/workgraph/api"
import { documentWorkSourcePinUrl, documentWorkSourceUrl } from "@/features/documents/data/documents-api"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { hash } from "@/lib/encode"

const adapterId = "claxedo_docs"

export type DocumentWorkGraphHandoffStage = "snapshot" | "discovery" | "source" | "placement" | "planning"
export type DocumentWorkGraphHandoffErrorCode =
  | "content_hash_mismatch"
  | "ambiguous_source"
  | "target_stream_required"
  | "invalid_result"
  | "command_rejected"

export class DocumentWorkGraphHandoffError extends Error {
  override readonly name = "DocumentWorkGraphHandoffError"

  constructor(
    readonly code: DocumentWorkGraphHandoffErrorCode,
    readonly stage: DocumentWorkGraphHandoffStage,
    message: string,
    readonly result?: Extract<CommandResult, { ok: false }>,
  ) {
    super(message)
  }
}

export type DocumentWorkGraphHandoffResult = Readonly<{
  proposalId: string
  source: Readonly<{ workSourceId: string; revisionId: string; contentHash: string }>
  targetStreamId?: string
}>

export function createDocumentWorkGraphHandoff(
  input: Readonly<{
    client: WorkGraphClient
    onSource?: (snapshot: DocumentSnapshotForWork, source: DocumentWorkGraphHandoffResult["source"]) => Promise<void>
  }>,
) {
  return async (snapshotInput: DocumentSnapshotForWork): Promise<DocumentWorkGraphHandoffResult> => {
    const snapshot = DocumentSnapshotForWorkSchema.parse(snapshotInput)
    const computedContentHash = ContentHashSchema.parse(await hash(snapshot.markdown))
    if (computedContentHash !== snapshot.contentHash) {
      throw new DocumentWorkGraphHandoffError(
        "content_hash_mismatch",
        "snapshot",
        "The selected document snapshot does not match its immutable content hash",
      )
    }

    const authoring = AuthoringSourceRevisionSchema.parse({
      adapterId,
      projectId: snapshot.locator.projectId,
      documentId: snapshot.locator.documentId,
      snapshotId: snapshot.locator.snapshotId,
      placement: snapshot.locator.placement,
      authoredAt: snapshot.authoredAt,
      authoredBy: snapshot.authoredBy,
      contentHash: computedContentHash,
    })
    const binding = await findAuthoringBinding(input.client, snapshot)
    const targetStreamId = await resolveTargetStream(input.client, snapshot, binding)
    const source = binding
      ? await appendAuthoringRevision(input.client, snapshot, binding, authoring)
      : await createAuthoringSource(input.client, snapshot, authoring)
    await input.onSource?.(snapshot, source)
    const proposal = await input.client.command({
      operationId: await operationId(snapshot, "planning", {
        targetStreamId,
        directory: snapshot.locator.directory,
        repositoryUrl: snapshot.locator.repositoryUrl,
      }),
      command: {
        version: 1,
        type: "propose_admission",
        source,
        ...(targetStreamId ? { targetStreamId } : {}),
        ...(!targetStreamId && snapshot.locator.directory
          ? {
              execution: {
                environment: { kind: "local_worktree", placement: "shared", directory: snapshot.locator.directory },
                repository: { baseRevision: "HEAD" },
              },
            }
          : !targetStreamId && snapshot.locator.repositoryUrl
            ? {
                execution: {
                  environment: { kind: "hosted_workspace", placement: "shared", repositoryUrl: snapshot.locator.repositoryUrl },
                  repository: { baseRevision: "HEAD" },
                },
              }
            : {}),
      },
    })
    if (!proposal.ok) throw rejected("planning", proposal)

    return {
      proposalId: resultId(proposal, "proposalId", "planning", AdmissionProposalIDSchema),
      source,
      ...(targetStreamId ? { targetStreamId } : {}),
    }
  }
}

export function createTurnDocumentIntoWork(
  input: Readonly<{
    snapshot: (request: DocumentWorkSourceRequest) => Promise<DocumentSnapshotForWork>
    handoff: (snapshot: DocumentSnapshotForWork) => Promise<DocumentWorkGraphHandoffResult>
  }>,
) {
  return async (requestInput: DocumentWorkSourceRequest): Promise<DocumentWorkGraphHandoffResult> => {
    const request = DocumentWorkSourceRequestSchema.parse(requestInput)
    return input.handoff(DocumentSnapshotForWorkSchema.parse(await input.snapshot(request)))
  }
}

export function createDocumentSnapshotApi(input: Readonly<{ baseUrl: string; request: typeof fetch }>) {
  const baseUrl = input.baseUrl.replace(/\/$/, "")
  return {
    async create(requestInput: DocumentWorkSourceRequest) {
      const request = DocumentWorkSourceRequestSchema.parse(requestInput)
      const response = await input.request(documentWorkSourceUrl(baseUrl, request.documentId), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(request.targetStreamId ? { target_stream_id: request.targetStreamId } : {}),
          ...(request.directory ? { directory: request.directory } : {}),
          ...(request.repositoryUrl ? { repository_url: request.repositoryUrl } : {}),
        }),
      })
      if (!response.ok) throw new Error(`Document snapshot intake is unavailable (${response.status})`)
      const snapshot = DocumentSnapshotForWorkSchema.parse(await response.json())
      if (
        snapshot.locator.projectId !== request.projectId ||
        snapshot.locator.documentId !== request.documentId ||
        snapshot.locator.placement !== request.placement
      )
        throw new Error("Document snapshot intake returned a different document identity")
      return snapshot
    },
    async pin(snapshot: DocumentSnapshotForWork, source: DocumentWorkGraphHandoffResult["source"]) {
      const response = await input.request(
        documentWorkSourcePinUrl(baseUrl, snapshot.locator.documentId, snapshot.locator.snapshotId),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ work_source_id: source.workSourceId, revision_id: source.revisionId }),
        },
      )
      if (!response.ok) throw new Error(`Document snapshot pin failed (${response.status})`)
    },
  }
}

const documentSnapshot = createDocumentSnapshotApi({
  baseUrl: getClaxedoServerUrl(),
  request: authFetch,
})
const documentWorkGraphHandoff = createDocumentWorkGraphHandoff({
  client: createWorkGraphClient({ request: authFetch }),
  onSource: documentSnapshot.pin,
})
export const turnDocumentIntoWork = createTurnDocumentIntoWork({
  snapshot: documentSnapshot.create,
  handoff: documentWorkGraphHandoff,
})

type AuthoringBinding = Readonly<{
  source: WorkSourceDto
  revision: WorkSourceRevisionDto & { origin: Extract<WorkSourceRevisionDto["origin"], { kind: "authoring" }> }
}>

async function findAuthoringBinding(client: WorkGraphClient, input: DocumentSnapshotForWork) {
  const matches: AuthoringBinding[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const page = await client.workSources({ ...(cursor ? { after: cursor } : {}), limit: 100 })
    const revisions = await Promise.all(
      page.sources.map(async (source) => ({
        source,
        revision: await client.sourceRevision(source.id, source.latestRevisionId),
      })),
    )
    revisions.forEach((candidate) => {
      const origin = candidate.revision.origin
      if (origin.kind !== "authoring") return
      if (origin.adapterId !== adapterId) return
      if (origin.projectId !== input.locator.projectId) return
      if (origin.documentId !== input.locator.documentId) return
      matches.push({ source: candidate.source, revision: { ...candidate.revision, origin } })
    })

    if (!page.hasMore) break
    if (!page.nextCursor || cursors.has(page.nextCursor)) {
      throw new DocumentWorkGraphHandoffError(
        "invalid_result",
        "discovery",
        "WorkGraph returned an invalid Work Source page cursor",
      )
    }
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  if (matches.length > 1) {
    throw new DocumentWorkGraphHandoffError(
      "ambiguous_source",
      "discovery",
      "More than one Work Source is bound to this Docs document",
    )
  }
  return matches[0]
}

async function resolveTargetStream(
  client: WorkGraphClient,
  input: DocumentSnapshotForWork,
  binding: AuthoringBinding | undefined,
) {
  if (input.locator.targetStreamId) return StreamIDSchema.parse(input.locator.targetStreamId)
  if (!binding) return undefined

  const streams = (await client.snapshot()).records.filter(
    (record) =>
      record.recordType === "stream" &&
      record.sourceRevisionRefs.some((source) => source.workSourceId === binding.source.id),
  )
  if (streams.length === 0) return undefined
  if (streams.length === 1) return streams[0]!.id
  throw new DocumentWorkGraphHandoffError(
    "target_stream_required",
    "placement",
    "This Docs document is connected to more than one Stream; choose the Stream for the new revision",
  )
}

async function createAuthoringSource(
  client: WorkGraphClient,
  input: DocumentSnapshotForWork,
  authoring: ReturnType<typeof AuthoringSourceRevisionSchema.parse>,
) {
  const result = await client.command({
    operationId: await operationId(input, "source"),
    command: {
      version: 1,
      type: "create_work_source",
      title: input.documentTitle,
      content: input.markdown,
      authoring,
    },
  })
  if (!result.ok) throw rejected("source", result)
  return WorkSourceRevisionRefSchema.parse({
    workSourceId: resultId(result, "workSourceId", "source", WorkSourceIDSchema),
    revisionId: resultId(result, "revisionId", "source", WorkSourceRevisionIDSchema),
    contentHash: authoring.contentHash,
  })
}

async function appendAuthoringRevision(
  client: WorkGraphClient,
  input: DocumentSnapshotForWork,
  binding: AuthoringBinding,
  authoring: ReturnType<typeof AuthoringSourceRevisionSchema.parse>,
) {
  if (binding.revision.origin.snapshotId === input.locator.snapshotId) {
    if (binding.revision.contentHash !== authoring.contentHash) {
      throw new DocumentWorkGraphHandoffError(
        "content_hash_mismatch",
        "source",
        "The existing Work Source revision has a different content hash for this document snapshot",
      )
    }
    return WorkSourceRevisionRefSchema.parse({
      workSourceId: binding.source.id,
      revisionId: binding.revision.id,
      contentHash: binding.revision.contentHash,
    })
  }
  const result = await client.command({
    operationId: await operationId(input, "source"),
    command: {
      version: 1,
      type: "revise_work_source",
      workSourceId: binding.source.id,
      expectedRevisionId: binding.revision.id,
      title: input.documentTitle,
      content: input.markdown,
      authoring,
    },
  })
  if (!result.ok) throw rejected("source", result)
  return WorkSourceRevisionRefSchema.parse({
    workSourceId: binding.source.id,
    revisionId: resultId(result, "revisionId", "source", WorkSourceRevisionIDSchema),
    contentHash: authoring.contentHash,
  })
}

async function operationId(input: DocumentSnapshotForWork, stage: "source" | "planning", context?: unknown) {
  return OperationIDSchema.parse(
    `docs:${await hash(
      JSON.stringify([
        adapterId,
        input.locator.projectId,
        input.locator.documentId,
        input.locator.snapshotId,
        stage,
        context,
      ]),
    )}`,
  )
}

function resultId<T>(
  result: Extract<CommandResult, { ok: true }>,
  key: string,
  stage: "source" | "planning",
  schema: Readonly<{
    safeParse(value: unknown): { success: true; data: T } | { success: false }
  }>,
) {
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    throw new DocumentWorkGraphHandoffError("invalid_result", stage, `WorkGraph command result is missing ${key}`)
  }
  const value = result.value[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new DocumentWorkGraphHandoffError("invalid_result", stage, `WorkGraph command result is missing ${key}`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new DocumentWorkGraphHandoffError("invalid_result", stage, `WorkGraph command result has an invalid ${key}`)
  }
  return parsed.data
}

function rejected(stage: "source" | "planning", result: Extract<CommandResult, { ok: false }>) {
  return new DocumentWorkGraphHandoffError("command_rejected", stage, result.error.message, result)
}
