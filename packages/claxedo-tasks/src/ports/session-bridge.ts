import type {
  ConfigurationSlot,
  Preset,
  SessionHandoffState,
  SessionLiveness,
  SessionReference,
  StartPreview,
  Task,
  TaskSessionLink,
  TasksActor,
  TasksResult,
} from "../contracts"

/**
 * As much of a stored link as a state reading needs. The origin decides the
 * first message's id, so the session alone cannot say whether this attempt's
 * task was handed over.
 */
export type SessionOrigin = {
  scopeId: string
  taskId: string
  slot: ConfigurationSlot
  attempt: number
  sessionRef: SessionReference
}

export type SessionStateReading = {
  session: SessionReference
  state: SessionLiveness
  handoff: SessionHandoffState
}

/**
 * Whether this actor may still read the previous session's transcript.
 *
 * The host resolves a workspace and a runtime before it can read anything, and
 * a grant withdrawn while it does has to stop the read rather than be noticed
 * after it: the answer is taken at the read, not inherited from the request
 * that started the Start.
 */
export type TranscriptGrant = () => Promise<boolean>

export type StartPreviewCommand = {
  actor: TasksActor
  task: Task
  preset: Preset
  slot: ConfigurationSlot
  attempt: number
  continueFromPrevious: boolean
  currentLink: TaskSessionLink | null
  currentState: SessionLiveness | null
  authorizeTranscript: TranscriptGrant
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
  authorizeTranscript: TranscriptGrant
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

/** A session a Start created and the package then refused to link, named by its origin. */
export type SessionAbandonCommand = {
  actor: TasksActor
  task: Task
  slot: ConfigurationSlot
  attempt: number
  /** The digest the origin was reserved under, so a host with a reservation compensates that one. */
  configurationDigest: string
  sessionRef: SessionReference
}

export type StartedSession = {
  sessionRef: SessionReference
  continuedFrom: SessionReference | null
}

/**
 * The host's half of Start. Liveness and handoff state are read here on every
 * request and never stored by Tasks; `preview` has no side effects.
 *
 * `start` and `handoff` are two calls because the link has to be durable
 * before the task is handed to anyone: `start` reserves the origin
 * `(scope, taskId, slot, attempt)` under the configuration digest and creates
 * or takes back over that session, the package commits the link, and `handoff`
 * then submits the first message. The message id comes from the origin and the
 * history is read first, so a handoff delivers at most once per readback: a
 * readback that finds the message sends nothing, and a runtime that will not
 * answer is refused rather than sent to again.
 *
 * `previousSession`, and a `currentLink` whose session is not deleted, reach
 * this port after the authorization port admitted that session, and
 * `authorizeTranscript` is asked again at the transcript read itself. A link
 * whose session the owner reports deleted is passed without a grant, because
 * its attempt number is what the next Start has to name; it is never offered
 * as a transcript to read.
 */
export type TasksSessionBridgePort = {
  sessionState(origins: readonly SessionOrigin[]): Promise<readonly SessionStateReading[]>
  preview(command: StartPreviewCommand): Promise<TasksResult<{ preview: StartPreview }>>
  start(command: StartCommand): Promise<TasksResult<{ session: StartedSession }>>
  /** `sent` is false when this origin's first message was already on the session. */
  handoff(command: SessionHandoffCommand): Promise<TasksResult<{ sent: boolean }>>
  /**
   * Undoes a create whose link never committed, so the origin is free for the
   * next Start. A session this origin's first message already reached is the
   * task's and is left alone; `removed` says which happened.
   */
  abandon(command: SessionAbandonCommand): Promise<TasksResult<{ removed: boolean }>>
}
