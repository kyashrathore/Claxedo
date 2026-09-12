import type {
  ConfigurationSlot,
  ModelConfiguration,
  PresetDraft,
  SessionLiveness,
  SessionReference,
  StartPreview,
  TasksActor,
  TasksErrorDetail,
} from "../contracts"
import { TasksError } from "../errors"
import type { HarnessDescriptor, TasksCapabilitiesPort, TasksHostCapabilities } from "../ports/capabilities"
import type { TasksAuthorizationPort } from "../ports/authorization"
import type { TasksClockPort } from "../ports/clock"
import type { TasksIdsPort } from "../ports/ids"
import type { StartCommand, StartPreviewCommand, TasksSessionBridgePort } from "../ports/session-bridge"

export const ACTOR: TasksActor = { scopeId: "scope-alpha", ownerId: "owner-alpha" }
export const OTHER_ACTOR: TasksActor = { scopeId: "scope-alpha", ownerId: "owner-beta" }
export const OTHER_SCOPE: TasksActor = { scopeId: "scope-beta", ownerId: "owner-alpha" }

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
    instructions: true,
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
  readonly starts: readonly StartCommand[]
  readonly previews: readonly StartPreviewCommand[]
}

export function fakeBridge(): FakeBridge {
  const states = new Map<string, SessionLiveness>()
  const starts: StartCommand[] = []
  const previews: StartPreviewCommand[] = []
  let nextSessionId = "session-1"
  let refusal: string | null = null

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
    async sessionState(sessions: readonly SessionReference[]) {
      return sessions.map((session) => ({ session, state: states.get(session.sessionId) ?? "live" }))
    },
    async preview(command) {
      previews.push(command)
      return { ok: true, preview: previewOf(command) }
    },
    async start(command) {
      starts.push(command)
      if (refusal !== null) return { ok: false, error: { code: "unsupported", message: refusal } }
      return {
        ok: true,
        session: {
          sessionRef: { sessionId: nextSessionId, workspaceId: "workspace-1" },
          continuedFrom: command.continueFromPrevious ? command.previousSession : null,
        },
      }
    },
    setState: (sessionId, state) => void states.set(sessionId, state),
    nextSession: (sessionId) => {
      nextSessionId = sessionId
    },
    refuseStart: (message) => {
      refusal = message
    },
    get starts() {
      return starts
    },
    get previews() {
      return previews
    },
  }
}

export function primaryConfiguration(overrides: Partial<ModelConfiguration> = {}): ModelConfiguration {
  return {
    harness: overrides.harness ?? { id: "claude", access: "native" },
    model: overrides.model ?? { providerID: "anthropic", modelID: "claude-sonnet" },
    effort: overrides.effort ?? null,
  }
}

export function presetDraft(overrides: Partial<PresetDraft> = {}): PresetDraft {
  return {
    name: overrides.name ?? "Local preset",
    instructions: overrides.instructions ?? "Work carefully.",
    execution: overrides.execution ?? { placement: "local", capabilities: { mode: "inherit-local" } },
    configurations: overrides.configurations ?? { primary: primaryConfiguration() },
  }
}

export function slotted(slot: Exclude<ConfigurationSlot, "primary">, configuration = primaryConfiguration()): PresetDraft {
  return presetDraft({ configurations: { primary: primaryConfiguration(), [slot]: configuration } })
}


/** The detail of the refusal `work` threw; an outcome that resolved is a test failure. */
export async function refusalOf(work: () => Promise<unknown>): Promise<TasksErrorDetail> {
  try {
    await work()
  } catch (cause) {
    if (cause instanceof TasksError) return cause.detail
    throw cause
  }
  throw new Error("Expected the call to be refused, but it resolved")
}

export function fieldReasons(detail: TasksErrorDetail): Record<string, string> {
  return Object.fromEntries((detail.fields ?? []).map((field) => [field.path, field.reason]))
}
