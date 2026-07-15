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
  DocumentRevisionForWorkSchema,
  type DocumentRevisionForWork,
  DocumentRevisionLocatorSchema,
  type DocumentRevisionLocator,
} from "@/features/documents/actions/doc-actions"
import {
  createDocsApi,
  type DurableDocumentRevision,
} from "@/features/documents/data/docs-api"
import { createWorkGraphClient, type WorkGraphClient } from "@/features/workgraph/api"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { hash } from "@/lib/encode"

const adapterId = "claxedo_docs"

export type DocumentWorkGraphHandoffStage = "revision" | "discovery" | "source" | "placement" | "planning"
export type DocumentWorkGraphHandoffErrorCode =
  | "content_hash_mismatch"
  | "ambiguous_source"
  | "revision_conflict"
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

export function createDocumentWorkGraphHandoff(input: Readonly<{ client: WorkGraphClient }>) {
  return async (revisionInput: DocumentRevisionForWork): Promise<DocumentWorkGraphHandoffResult> => {
    const revision = DocumentRevisionForWorkSchema.parse(revisionInput)
    const computedContentHash = ContentHashSchema.parse(await hash(revision.markdown))
    if (computedContentHash !== revision.contentHash) {
      throw new DocumentWorkGraphHandoffError(
        "content_hash_mismatch",
        "revision",
        "The selected Docs revision content does not match its immutable content hash",
      )
    }

    const authoring = AuthoringSourceRevisionSchema.parse({
      adapterId,
      projectId: revision.projectId,
      documentId: revision.documentId,
      documentRevisionId: revision.revisionId,
      documentRevisionNumber: revision.revisionNumber,
      ...(revision.parentRevisionId ? { parentDocumentRevisionId: revision.parentRevisionId } : {}),
      authoredAt: revision.authoredAt,
      authoredBy: revision.authoredBy,
      contentHash: computedContentHash,
    })
    const binding = await findAuthoringBinding(input.client, revision)
    const targetStreamId = await resolveTargetStream(input.client, revision, binding)
    const source = binding
      ? await appendAuthoringRevision(input.client, revision, binding, authoring)
      : await createAuthoringSource(input.client, revision, authoring)
    const proposal = await input.client.command({
      operationId: await operationId(revision, "planning"),
      command: {
        version: 1,
        type: "propose_admission",
        source,
        ...(targetStreamId ? { targetStreamId } : {}),
        ...(!targetStreamId && revision.directory ? {
          execution: {
            environment: { kind: "local_worktree", directory: revision.directory },
            repository: { baseRevision: "HEAD" },
          },
        } : !targetStreamId && revision.repositoryUrl ? {
          execution: {
            environment: { kind: "hosted_workspace", repositoryUrl: revision.repositoryUrl },
            repository: { baseRevision: "HEAD" },
          },
        } : {}),
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

export function createTurnDocumentRevisionIntoWork(input: Readonly<{
  readRevision: (locator: DocumentRevisionLocator) => Promise<DurableDocumentRevision>
  handoff: (revision: DocumentRevisionForWork) => Promise<DocumentWorkGraphHandoffResult>
}>) {
  return async (locatorInput: DocumentRevisionLocator): Promise<DocumentWorkGraphHandoffResult> => {
    const locator = DocumentRevisionLocatorSchema.parse(locatorInput)
    const revision = await input.readRevision(locator)
    return input.handoff(DocumentRevisionForWorkSchema.parse({
      ...revision,
      ...(locator.targetStreamId ? { targetStreamId: locator.targetStreamId } : {}),
      ...(locator.directory ? { directory: locator.directory } : {}),
      ...(locator.repositoryUrl ? { repositoryUrl: locator.repositoryUrl } : {}),
    }))
  }
}

const docsApi = createDocsApi({
  baseUrl: getClaxedoServerUrl(),
  request: authFetch,
})
const documentWorkGraphHandoff = createDocumentWorkGraphHandoff({
  client: createWorkGraphClient({ request: authFetch }),
})
export const turnDocumentRevisionIntoWork = createTurnDocumentRevisionIntoWork({
  readRevision: docsApi.revisionForWork,
  handoff: documentWorkGraphHandoff,
})

type AuthoringBinding = Readonly<{
  source: WorkSourceDto
  revision: WorkSourceRevisionDto & { origin: Extract<WorkSourceRevisionDto["origin"], { kind: "authoring" }> }
}>

async function findAuthoringBinding(client: WorkGraphClient, input: DocumentRevisionForWork) {
  const matches: AuthoringBinding[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const page = await client.workSources({ ...(cursor ? { after: cursor } : {}), limit: 100 })
    const revisions = await Promise.all(page.sources.map(async (source) => ({
      source,
      revision: await client.sourceRevision(source.id, source.latestRevisionId),
    })))
    revisions.forEach((candidate) => {
      const origin = candidate.revision.origin
      if (origin.kind !== "authoring") return
      if (origin.adapterId !== adapterId) return
      if (origin.projectId !== input.projectId) return
      if (origin.documentId !== input.documentId) return
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
  input: DocumentRevisionForWork,
  binding: AuthoringBinding | undefined,
) {
  if (input.targetStreamId) return StreamIDSchema.parse(input.targetStreamId)
  if (!binding) return undefined

  const streams = (await client.snapshot()).records.filter((record) =>
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
  input: DocumentRevisionForWork,
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
  input: DocumentRevisionForWork,
  binding: AuthoringBinding,
  authoring: ReturnType<typeof AuthoringSourceRevisionSchema.parse>,
) {
  if (binding.revision.origin.documentRevisionId === input.revisionId) {
    if (binding.revision.contentHash !== authoring.contentHash) {
      throw new DocumentWorkGraphHandoffError(
        "content_hash_mismatch",
        "source",
        "The existing Work Source revision has a different content hash for this Docs revision",
      )
    }
    return WorkSourceRevisionRefSchema.parse({
      workSourceId: binding.source.id,
      revisionId: binding.revision.id,
      contentHash: binding.revision.contentHash,
    })
  }
  if (
    input.revisionNumber <= binding.revision.origin.documentRevisionNumber ||
    input.parentRevisionId !== binding.revision.origin.documentRevisionId
  ) {
    throw new DocumentWorkGraphHandoffError(
      "revision_conflict",
      "source",
      "The selected Docs revision does not directly descend from the Work Source head",
    )
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

async function operationId(input: DocumentRevisionForWork, stage: "source" | "planning") {
  return OperationIDSchema.parse(`docs:${await hash(JSON.stringify([
    adapterId,
    input.projectId,
    input.documentId,
    input.revisionId,
    stage,
  ]))}`)
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
