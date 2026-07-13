import type {
  OperationID,
  WorkGraphContext,
  WorkSourceDto,
  WorkSourceID,
  WorkSourceRevisionDto,
  WorkSourceRevisionID,
} from "../contracts"

export type ManualWorkSourceWriteResult = Readonly<{
  source: WorkSourceDto
  revision: WorkSourceRevisionDto
}>

export type WorkSourcePort = Readonly<{
  createManual(
    context: WorkGraphContext,
    input: Readonly<{
      operationId: OperationID
      title: string
      content: string
    }>,
  ): Promise<ManualWorkSourceWriteResult>

  reviseManual(
    context: WorkGraphContext,
    input: Readonly<{
      operationId: OperationID
      workSourceId: WorkSourceID
      expectedRevisionId: WorkSourceRevisionID
      title?: string
      content: string
    }>,
  ): Promise<ManualWorkSourceWriteResult>

  readSource(context: WorkGraphContext, input: Readonly<{ workSourceId: WorkSourceID }>): Promise<WorkSourceDto | undefined>

  readRevision(
    context: WorkGraphContext,
    input: Readonly<{
      workSourceId: WorkSourceID
      revisionId: WorkSourceRevisionID
    }>,
  ): Promise<WorkSourceRevisionDto | undefined>
}>
