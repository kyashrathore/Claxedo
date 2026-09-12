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
  continueFromPrevious: boolean
  clientRequestId: string
  /** `startConfigurationDigest` of this preset and slot; the host reserves the origin under it. */
  configurationDigest: string
  /** The slot's previous session, when Continue was chosen; null starts from task text alone. */
  previousSession: SessionReference | null
}

export type SessionHandoffCommand = {
  actor: TasksActor
  task: Task
  slot: ConfigurationSlot
  attempt: number
  handoffText: string | null
  /** The session the committed link names, which is the only one this task is handed to. */
  session: SessionReference
}

export type StartedSession = {
  sessionRef: SessionReference
  continuedFrom: SessionReference | null
}

/**
 * The host's half of Start. Liveness is read here on every request and never
 * stored by Tasks; `preview` has no side effects.
 *
 * `start` and `handoff` are two calls because the link has to be durable
 * before the task is handed to anyone: `start` reserves the origin
 * `(scope, taskId, slot, attempt)` under the configuration digest and creates
 * or takes back over that session, the package commits the link, and `handoff`
 * then submits the first message. The origin decides the message id, so a
 * retry after a crash between the two sends the message once and a retry after
 * it landed sends nothing.
 *
 * `currentLink` and `previousSession` reach this port only after the
 * authorization port admitted that session, which is what lets `preview` read
 * the previous transcript to answer whether it is readable.
 */
export type TasksSessionBridgePort = {
  sessionState(sessions: readonly SessionReference[]): Promise<readonly SessionStateReading[]>
  preview(command: StartPreviewCommand): Promise<TasksResult<{ preview: StartPreview }>>
  start(command: StartCommand): Promise<TasksResult<{ session: StartedSession }>>
  /** `sent` is false when this origin's first message was already on the session. */
  handoff(command: SessionHandoffCommand): Promise<TasksResult<{ sent: boolean }>>
}
