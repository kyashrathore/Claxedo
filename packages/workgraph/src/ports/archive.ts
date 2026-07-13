import type { OperationID, WorkGraphArchive, WorkGraphArchiveRestoreResult, WorkGraphContext } from "../contracts"

export type { WorkGraphArchiveRestoreResult } from "../contracts"

export type WorkGraphArchivePort = Readonly<{
  export: (context: WorkGraphContext) => Promise<WorkGraphArchive>
  restore: (
    context: WorkGraphContext,
    input: Readonly<{ operationId: OperationID; archive: WorkGraphArchive }>,
  ) => Promise<WorkGraphArchiveRestoreResult>
}>
