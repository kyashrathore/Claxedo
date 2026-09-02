import {
  AGENT_HARNESS_DEFINITIONS,
  type AgentHarnessAccess,
  type SessionHarnessId,
  type AgentHarnessKey,
  type AgentHarnessTransport,
} from "./harness-types"

export type AgentProcessRole = "harness" | "probe" | "mcp" | "tool"
export type AgentProcessLocality = "local-process" | "in-process" | "remote"
export type AgentProcessConfidence = "direct" | "inferred" | "not-process-backed"

export type AgentProcessCapabilities = {
  resourceMetrics: "process" | "shared-process" | "none"
  ownerActions: boolean
}

export type AgentProcessDescriptor = {
  ownerId: string
  launchId: string
  harnessId: SessionHarnessId
  access: AgentHarnessAccess
  role: AgentProcessRole
  label: string
  locality: AgentProcessLocality
  confidence: AgentProcessConfidence
  capabilities: AgentProcessCapabilities
  pid?: number
  parentOwnerId?: string
  workspaceId?: string
  directory?: string
  sessionId?: string
  executableBasename?: string
  mcpName?: string
  transport?: AgentHarnessTransport
}

export type AgentProcessLifecycle = "starting" | "ready" | "detached"

export type AgentProcessObserverHandle = {
  update(input: {
    lifecycle: AgentProcessLifecycle
    pid?: number
    confidence?: AgentProcessConfidence
  }): void
  exit(input: {
    reason: "exited" | "error" | "timeout" | "cancelled" | "disposed" | "detached"
    exitCode?: number
  }): void
}

export type AgentProcessObserver = {
  register(descriptor: AgentProcessDescriptor): AgentProcessObserverHandle
}

export type AgentProcessAttributionScenario = {
  key: AgentHarnessKey
  root: "direct-pid" | "inferred-local" | "in-process"
  probe: "direct-pid" | "shared-process" | "remote" | "unsupported"
  mcp: "stdio-and-remote" | "unsupported"
}

const attributionScenarioByHarness = {
  claude: { root: "direct-pid", probe: "direct-pid", mcp: "stdio-and-remote" },
  codex: { root: "direct-pid", probe: "shared-process", mcp: "stdio-and-remote" },
  cursor: { root: "inferred-local", probe: "remote", mcp: "stdio-and-remote" },
  opencode: { root: "direct-pid", probe: "unsupported", mcp: "stdio-and-remote" },
  pi: { root: "in-process", probe: "unsupported", mcp: "unsupported" },
} as const satisfies Record<
  AgentHarnessKey,
  Omit<AgentProcessAttributionScenario, "key">
>

export const AGENT_PROCESS_ATTRIBUTION_SCENARIOS = AGENT_HARNESS_DEFINITIONS.map((definition) => ({
  key: definition.key,
  ...attributionScenarioByHarness[definition.key],
})) satisfies AgentProcessAttributionScenario[]

const noopHandle: AgentProcessObserverHandle = {
  update: () => undefined,
  exit: () => undefined,
}

/**
 * Diagnostics is optional. A rejected descriptor or a failing host sink must
 * never prevent an agent process from starting, updating, or exiting.
 */
export function observeAgentProcess(
  observer: AgentProcessObserver | undefined,
  descriptor: AgentProcessDescriptor,
): AgentProcessObserverHandle {
  if (!observer) return noopHandle
  try {
    const handle = observer.register(safeAgentProcessDescriptor(descriptor))
    return {
      update(input) {
        try {
          handle.update({
            lifecycle: input.lifecycle,
            ...(input.pid !== undefined ? { pid: requirePid(input.pid) } : {}),
            ...(input.confidence ? { confidence: input.confidence } : {}),
          })
        } catch {}
      },
      exit(input) {
        try {
          handle.exit({
            reason: input.reason,
            ...(input.exitCode !== undefined ? { exitCode: requireExitCode(input.exitCode) } : {}),
          })
        } catch {}
      },
    }
  } catch {
    return noopHandle
  }
}

export function safeAgentProcessDescriptor(input: AgentProcessDescriptor): AgentProcessDescriptor {
  const pid = input.pid === undefined ? undefined : requirePid(input.pid)
  if (input.locality !== "local-process" && pid !== undefined) {
    throw new Error("Only local process observations may carry a PID")
  }
  if (input.confidence === "not-process-backed" && input.capabilities.resourceMetrics !== "none") {
    throw new Error("A non-process-backed observation cannot expose process metrics")
  }
  if (input.capabilities.ownerActions && (input.locality !== "local-process" || input.confidence !== "direct" || pid === undefined)) {
    throw new Error("Owner actions require a directly observed local PID")
  }
  return {
    ownerId: safeIdentifier(input.ownerId),
    launchId: safeIdentifier(input.launchId),
    harnessId: input.harnessId,
    access: input.access,
    role: input.role,
    label: safeText(input.label, 256),
    locality: input.locality,
    confidence: input.confidence,
    capabilities: {
      resourceMetrics: input.capabilities.resourceMetrics,
      ownerActions: input.capabilities.ownerActions,
    },
    ...(pid !== undefined ? { pid } : {}),
    ...(input.parentOwnerId ? { parentOwnerId: safeIdentifier(input.parentOwnerId) } : {}),
    ...(input.workspaceId ? { workspaceId: safeIdentifier(input.workspaceId) } : {}),
    ...(input.directory ? { directory: safeText(input.directory, 4_096) } : {}),
    ...(input.sessionId ? { sessionId: safeIdentifier(input.sessionId) } : {}),
    ...(input.executableBasename ? { executableBasename: safeBasename(input.executableBasename) } : {}),
    ...(input.mcpName ? { mcpName: safeIdentifier(input.mcpName) } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
  }
}

function safeIdentifier(value: string) {
  const result = safeText(value, 256)
  if (!result) throw new Error("Agent process observer identifiers must not be empty")
  return result
}

function safeBasename(value: string) {
  const result = safeIdentifier(value)
  if (result.includes("/") || result.includes("\\")) {
    throw new Error("Agent process observer executable names must be basenames")
  }
  return result
}

function safeText(value: string, max: number) {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127 ? " " : character
    })
    .join("")
    .trim()
    .slice(0, max)
}

function requirePid(value: number) {
  if (!Number.isInteger(value) || value <= 0) throw new Error("Agent process observer PID must be a positive integer")
  return value
}

function requireExitCode(value: number) {
  if (!Number.isInteger(value)) throw new Error("Agent process observer exit code must be an integer")
  return value
}
