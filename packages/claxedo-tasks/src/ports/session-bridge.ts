import type {
  ConfigurationSlot,
  Preset,
  SessionLiveness,
  SessionReference,
  StartPreview,
  Task,
  TaskSessionLink,
  TasksActor,
  TasksResult,
} from "../contracts"

export type SessionStateReading = {
  session: SessionReference
  state: SessionLiveness
}

export type StartPreviewCommand = {
  actor: TasksActor
  task: Task
  preset: Preset
  slot: ConfigurationSlot
  attempt: number
  continueFromPrevious: boolean
  currentLink: TaskSessionLink | null
  currentState: SessionLiveness | null
}

export type StartCommand = {
  actor: TasksActor
  task: Task
  preset: Preset
  slot: ConfigurationSlot
  attempt: number
  previewDigest: string
  handoffText: string | null
  continueFromPrevious: boolean
  clientRequestId: string
  /** The slot's previous session, when Continue was chosen; null starts from task text alone. */
  previousSession: SessionReference | null
}

export type StartedSession = {
  sessionRef: SessionReference
  continuedFrom: SessionReference | null
}

/**
 * The host's half of Start. Liveness is read here on every request and never
 * stored by Tasks; `preview` has no side effects; `start` reserves the origin
 * `(scope, taskId, slot, attempt)`, creates the ordinary session with the
 * resolved configuration and instructions, and performs the first handoff.
 * The package supplies validated, authorized records and persists the link.
 */
export type TasksSessionBridgePort = {
  sessionState(sessions: readonly SessionReference[]): Promise<readonly SessionStateReading[]>
  preview(command: StartPreviewCommand): Promise<TasksResult<{ preview: StartPreview }>>
  start(command: StartCommand): Promise<TasksResult<{ session: StartedSession }>>
}
