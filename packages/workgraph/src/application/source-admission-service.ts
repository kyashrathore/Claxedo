import type {
  AdmissionProposalID,
  AdmissionOutcomeInput,
  AdmissionSelection,
  AdmissionWorkItemInput,
  CommandResult,
  OperationID,
  StreamID,
  WorkGraphContext,
  WorkGraphCommandRequest,
  WorkSourceRevisionRef,
} from "../contracts"

export type AdmissionCommandGateway = Readonly<{
  execute(
    context: WorkGraphContext,
    request: WorkGraphCommandRequest,
  ): Promise<CommandResult>
}>

export type SourceAdmissionService = Readonly<{
  propose(
    context: WorkGraphContext,
    input: Readonly<{ operationId: OperationID; source: WorkSourceRevisionRef; targetStreamId?: StreamID }>,
  ): Promise<CommandResult>
  dismiss(
    context: WorkGraphContext,
    input: Readonly<{ operationId: OperationID; proposalId: AdmissionProposalID; expectedVersion: number }>,
  ): Promise<CommandResult>
  reopen(
    context: WorkGraphContext,
    input: Readonly<{ operationId: OperationID; proposalId: AdmissionProposalID; expectedVersion: number }>,
  ): Promise<CommandResult>
  confirm(
    context: WorkGraphContext,
    input: Readonly<{
      operationId: OperationID
      proposalId: AdmissionProposalID
      expectedVersion: number
      source: WorkSourceRevisionRef
      selection: AdmissionSelection
      outcomes?: AdmissionOutcomeInput[]
      workItems?: AdmissionWorkItemInput[]
    }>,
  ): Promise<CommandResult>
}>

/** Analysis creates a reviewable proposal; only confirm may materialize work. */
export function createSourceAdmissionService(gateway: AdmissionCommandGateway): SourceAdmissionService {
  return {
    propose: (
      context: WorkGraphContext,
      input: Readonly<{ operationId: OperationID; source: WorkSourceRevisionRef; targetStreamId?: StreamID }>,
    ) => gateway.execute(context, {
      operationId: input.operationId,
      command: { version: 1, type: "propose_admission", source: input.source, ...(input.targetStreamId ? { targetStreamId: input.targetStreamId } : {}) },
    }),
    dismiss: (context, input) => gateway.execute(context, {
      operationId: input.operationId,
      command: {
        version: 1,
        type: "dismiss_admission",
        proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
      },
    }),
    reopen: (context, input) => gateway.execute(context, {
      operationId: input.operationId,
      command: {
        version: 1,
        type: "reopen_admission",
        proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
      },
    }),
    confirm: (
      context: WorkGraphContext,
      input: Readonly<{
        operationId: OperationID
        proposalId: AdmissionProposalID
        expectedVersion: number
        source: WorkSourceRevisionRef
        selection: AdmissionSelection
        outcomes?: AdmissionOutcomeInput[]
        workItems?: AdmissionWorkItemInput[]
      }>,
    ) => gateway.execute(context, {
      operationId: input.operationId,
      command: {
        version: 1,
        type: "confirm_admission",
        proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
        source: input.source,
        selection: input.selection,
        ...(input.outcomes ? { outcomes: input.outcomes } : {}),
        ...(input.workItems ? { workItems: input.workItems } : {}),
      },
    }),
  }
}
