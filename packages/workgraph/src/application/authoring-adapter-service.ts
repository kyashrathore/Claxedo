import type {
  AdmissionProposalID,
  AuthoringSourceRevision,
  CommandResult,
  OperationID,
  StreamID,
  WorkGraphContext,
  WorkGraphCommandRequest,
  WorkSourceID,
  WorkSourceRevisionID,
  WorkSourceRevisionRef,
} from "../contracts"
import { hashWorkSourceContent } from "./work-source-service"

export type WorkGraphAuthoringAdapterGateway = Readonly<{
  execute(context: WorkGraphContext, request: WorkGraphCommandRequest): Promise<CommandResult>
}>

export type WorkGraphAuthoringBinding = Readonly<{
  workSourceId: WorkSourceID
  latestRevisionId: WorkSourceRevisionID
}>

export type TurnAuthoringRevisionIntoWorkResult =
  | Readonly<{ ok: true; source: WorkSourceRevisionRef; proposalId: AdmissionProposalID }>
  | Readonly<{ ok: false; stage: "source" | "planning"; result: Extract<CommandResult, { ok: false }> }>

export class AuthoringContentHashMismatchError extends Error {
  override readonly name = "AuthoringContentHashMismatchError"
}

/**
 * The authoring surface supplies one exact immutable revision. WorkGraph owns
 * source persistence, strict Session planning, and every later execution row.
 */
export function createWorkGraphAuthoringAdapter(gateway: WorkGraphAuthoringAdapterGateway) {
  return {
    async turnIntoWork(context: WorkGraphContext, input: Readonly<{
      operationId: OperationID
      title: string
      content: string
      revision: AuthoringSourceRevision
      binding?: WorkGraphAuthoringBinding
      targetStreamId?: StreamID
    }>): Promise<TurnAuthoringRevisionIntoWorkResult> {
      if (hashWorkSourceContent(input.content) !== input.revision.contentHash) {
        throw new AuthoringContentHashMismatchError("Authoring revision content does not match its declared content hash")
      }
      const sourceResult = await gateway.execute(context, {
        operationId: `${input.operationId}:source` as OperationID,
        command: input.binding
          ? {
              version: 1,
              type: "revise_work_source",
              workSourceId: input.binding.workSourceId,
              expectedRevisionId: input.binding.latestRevisionId,
              title: input.title,
              content: input.content,
              authoring: input.revision,
            }
          : {
              version: 1,
              type: "create_work_source",
              title: input.title,
              content: input.content,
              authoring: input.revision,
            },
      })
      if (!sourceResult.ok) return { ok: false, stage: "source", result: sourceResult }
      const workSourceId = commandValue(sourceResult, "workSourceId") as WorkSourceID
      const revisionId = commandValue(sourceResult, "revisionId") as WorkSourceRevisionID
      const source = { workSourceId, revisionId, contentHash: input.revision.contentHash }
      const proposalResult = await gateway.execute(context, {
        operationId: `${input.operationId}:planning` as OperationID,
        command: {
          version: 1,
          type: "propose_admission",
          source,
          ...(input.targetStreamId ? { targetStreamId: input.targetStreamId } : {}),
        },
      })
      if (!proposalResult.ok) return { ok: false, stage: "planning", result: proposalResult }
      return { ok: true, source, proposalId: commandValue(proposalResult, "proposalId") as AdmissionProposalID }
    },
  }
}

function commandValue(result: Extract<CommandResult, { ok: true }>, key: string) {
  if (!result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    throw new Error(`WorkGraph command result is missing ${key}`)
  }
  const value = result.value[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`WorkGraph command result is missing ${key}`)
  return value
}
