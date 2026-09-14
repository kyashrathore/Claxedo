import type { ConfigurationSlot, SessionHandoffState, SessionLiveness, StartPreview, TasksActor } from "../contracts"
import type { HarnessDescriptor, TasksCapabilitiesPort, TasksHostCapabilities } from "../ports/capabilities"
import type { TasksAuthorizationPort } from "../ports/authorization"
import type { TasksClockPort } from "../ports/clock"
import type { TasksIdsPort } from "../ports/ids"
import type {
  SessionAbandonCommand,
  SessionHandoffCommand,
  SessionOrigin,
  StartCommand,
  StartPreviewCommand,
  TasksSessionBridgePort,
} from "../ports/session-bridge"
import { OWNER, SCOPES, primaryConfiguration } from "./rows"

export const ACTOR: TasksActor = { scopeId: SCOPES.first, ownerId: OWNER }
export const OTHER_ACTOR: TasksActor = { scopeId: SCOPES.first, ownerId: "owner-beta" }
export const OTHER_SCOPE: TasksActor = { scopeId: SCOPES.second, ownerId: OWNER }

export function fakeClock(start = 1_000): TasksClockPort & { set(value: number): void } {
  let now = start
  return {
    now: () => (now += 1),
    set: (value) => {
      now = value
    },
  }
}

export function fakeIds(): TasksIdsPort {
  let presets = 0
  let tasks = 0
  return {
    presetId: () => `preset-${(presets += 1)}`,
    taskId: () => `task-${(tasks += 1)}`,
  }
}

export const HARNESSES: readonly HarnessDescriptor[] = [
  { id: "claude", access: "native", efforts: ["low", "high"] },
  { id: "codex", access: "native", efforts: [] },
  { id: "cursor", access: "connection", efforts: ["medium"] },
]

export function fakeCapabilities(overrides: Partial<TasksHostCapabilities> = {}): TasksCapabilitiesPort {
  const host: TasksHostCapabilities = {
    placements: ["local", "cloud"],
    cloudSelectedCapabilities: true,
    ...overrides,
  }
  return {
    async describe() {
      return host
    },
    async harness(reference) {
      return HARNESSES.find((entry) => entry.id === reference.id && entry.access === reference.access)
    },
  }
}

export type FakeAuthorization = TasksAuthorizationPort & {
  denyProject(projectId: string): void
  denySession(sessionId: string): void
}

export function fakeAuthorization(): FakeAuthorization {
  const deniedProjects = new Set<string>()
  const deniedSessions = new Set<string>()
  return {
    async authorizeProject(_actor, projectId) {
      return !deniedProjects.has(projectId)
    },
    async authorizeSessionOpen(_actor, session) {
      return !deniedSessions.has(session.sessionId)
    },
    denyProject: (projectId) => void deniedProjects.add(projectId),
    denySession: (sessionId) => void deniedSessions.add(sessionId),
  }
}

export type FakeBridge = TasksSessionBridgePort & {
  setState(sessionId: string, state: SessionLiveness): void
  nextSession(sessionId: string): void
  refuseStart(message: string): void
  /** Null clears the refusal, for a retry after the host would not answer. */
  refuseHandoff(message: string | null): void
  readonly starts: readonly StartCommand[]
  readonly previews: readonly StartPreviewCommand[]
  /** Every handoff asked for, including the ones already on the session. */
  readonly handoffs: readonly SessionHandoffCommand[]
  /** The handoffs that submitted a message, which is what must happen once. */
  readonly delivered: readonly SessionHandoffCommand[]
  readonly abandoned: readonly SessionAbandonCommand[]
  /** Every previous-session transcript this bridge was allowed to read. */
  readonly transcriptReads: readonly string[]
}

export function fakeBridge(): FakeBridge {
  const states = new Map<string, SessionLiveness>()
  const starts: StartCommand[] = []
  const previews: StartPreviewCommand[] = []
  const handoffs: SessionHandoffCommand[] = []
  const delivered: SessionHandoffCommand[] = []
  const abandoned: SessionAbandonCommand[] = []
  const transcriptReads: string[] = []
  const sent = new Set<string>()
  // The real host derives the message id from the origin, so the same origin
  // sent to the same session is the message that is already there.
  const originKey = (input: { sessionId: string; taskId: string; slot: ConfigurationSlot; attempt: number }) =>
    `${input.sessionId}:${input.taskId}:${input.slot}:${input.attempt}`
  let nextSessionId = "session-1"
  let refusal: string | null = null
  let handoffRefusal: string | null = null

  const previewOf = (command: StartPreviewCommand): StartPreview => {
    const configuration = command.preset.configurations[command.slot]
    return {
      digest: `digest-${command.task.id}-${command.slot}-${command.attempt}`,
      expiresAt: 9_000,
      placement: command.preset.execution.placement,
      slot: command.slot,
      attempt: command.attempt,
      configuration: configuration ?? primaryConfiguration(),
      capabilities: command.preset.execution.capabilities,
      available: true,
      blockers: [],
      currentSession: command.currentLink
        ? { sessionRef: command.currentLink.sessionRef, liveness: command.currentState ?? "unavailable" }
        : null,
      previousTranscriptReadable: command.currentState === "archived",
      destinationDescription: "Local workspace",
    }
  }

  return {
    async sessionState(origins: readonly SessionOrigin[]) {
      return origins.map((origin) => {
        const state = states.get(origin.sessionRef.sessionId) ?? "live"
        const handoff: SessionHandoffState = state !== "live"
          ? "unknown"
          : sent.has(originKey({ ...origin, sessionId: origin.sessionRef.sessionId }))
            ? "sent"
            : "pending"
        return { session: origin.sessionRef, state, handoff }
      })
    },
    async preview(command) {
      previews.push(command)
      const readable = command.currentState !== null && command.currentState !== "deleted"
      if (readable && !(await command.authorizeTranscript())) {
        return { ok: false, error: { code: "forbidden", message: "The transcript grant was withdrawn" } }
      }
      if (readable) transcriptReads.push(command.currentLink?.sessionRef.sessionId ?? "")
      return { ok: true, preview: previewOf(command) }
    },
    async start(command) {
      starts.push(command)
      if (command.previousSession && !(await command.authorizeTranscript())) {
        return { ok: false, error: { code: "forbidden", message: "The transcript grant was withdrawn" } }
      }
      if (command.previousSession) transcriptReads.push(command.previousSession.sessionId)
      if (refusal !== null) return { ok: false, error: { code: "unsupported", message: refusal } }
      return {
        ok: true,
        session: {
          sessionRef: { sessionId: nextSessionId, workspaceId: "workspace-1" },
          continuedFrom: command.continueFromPrevious ? command.previousSession : null,
        },
      }
    },
    async handoff(command) {
      handoffs.push(command)
      if (handoffRefusal !== null) return { ok: false, error: { code: "conflict", message: handoffRefusal } }
      const origin = originKey({
        sessionId: command.session.sessionId,
        taskId: command.task.id,
        slot: command.slot,
        attempt: command.attempt,
      })
      if (sent.has(origin)) return { ok: true, sent: false }
      sent.add(origin)
      delivered.push(command)
      return { ok: true, sent: true }
    },
    async abandon(command) {
      abandoned.push(command)
      const origin = originKey({
        sessionId: command.sessionRef.sessionId,
        taskId: command.task.id,
        slot: command.slot,
        attempt: command.attempt,
      })
      if (sent.has(origin)) return { ok: true, removed: false }
      states.set(command.sessionRef.sessionId, "deleted")
      return { ok: true, removed: true }
    },
    setState: (sessionId, state) => void states.set(sessionId, state),
    nextSession: (sessionId) => {
      nextSessionId = sessionId
    },
    refuseStart: (message) => {
      refusal = message
    },
    refuseHandoff: (message) => {
      handoffRefusal = message
    },
    get starts() {
      return starts
    },
    get previews() {
      return previews
    },
    get handoffs() {
      return handoffs
    },
    get delivered() {
      return delivered
    },
    get abandoned() {
      return abandoned
    },
    get transcriptReads() {
      return transcriptReads
    },
  }
}
