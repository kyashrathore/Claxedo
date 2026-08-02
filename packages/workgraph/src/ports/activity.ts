import type {
  AgentCheckpointDto,
  AttachSessionTaskInput,
  BindSessionInput,
  RecordAgentCheckpointInput,
  ReleaseSessionBindingInput,
  SessionBindingDto,
  SessionBindingID,
  TaskActivityListInput,
  TaskActivityPage,
  WorkGraphContext,
} from "../contracts"

export type WorkGraphActivityPort = Readonly<{
  list(context: WorkGraphContext, input: TaskActivityListInput): Promise<TaskActivityPage>
}>

export type WorkGraphSessionBindingPort = Readonly<{
  bind(context: WorkGraphContext, input: BindSessionInput): Promise<SessionBindingDto>
  attachTask(context: WorkGraphContext, input: AttachSessionTaskInput): Promise<SessionBindingDto>
  recordCheckpoint(context: WorkGraphContext, input: RecordAgentCheckpointInput): Promise<AgentCheckpointDto>
  release(context: WorkGraphContext, input: ReleaseSessionBindingInput): Promise<SessionBindingDto>
  read(context: WorkGraphContext, bindingId: SessionBindingID): Promise<SessionBindingDto | undefined>
  readForSession(context: WorkGraphContext, sessionId: string): Promise<SessionBindingDto | undefined>
}>

export type WorkGraphSessionBindingErrorCode = "not_found" | "conflict" | "not_ready" | "invalid_transition"

export class WorkGraphSessionBindingError extends Error {
  constructor(readonly code: WorkGraphSessionBindingErrorCode, message: string) {
    super(message)
    this.name = "WorkGraphSessionBindingError"
  }
}
