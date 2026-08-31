import type { SessionHarnessId } from "./harness-types"
import type { OpenCodeRequestFn } from "./harnesses/opencode"
import type { ActivityLease } from "./harnesses/shared/process-lifecycle"

export type HarnessCapabilityTarget = SessionHarnessId
export type AdapterCapability = "http-proxy" | "runtime-config"

export type HarnessCapabilities = {
  harness: HarnessCapabilityTarget
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
  subagents: boolean
  /** Runtime availability only. Detailed support is read from `SupportsGoals.goals`. */
  goals: boolean
}

export type HarnessCapabilityContext = {
  sessionId?: string
}

export function harnessCapabilities(input: HarnessCapabilities): HarnessCapabilities {
  return input
}

export const GOAL_ACTIONS = ["pause", "resume", "delete"] as const
export type GoalAction = typeof GOAL_ACTIONS[number]
export type GoalRecovery = "reconcile" | "blocked"
export const GOAL_OPTIONAL_FIELDS = [
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
  "iteration",
  "lastReason",
] as const
export type GoalOptionalField = typeof GOAL_OPTIONAL_FIELDS[number]

export type GoalCapabilities = {
  /** Whether this adapter contains a real Goal implementation. */
  implemented: boolean
  /** Whether that implementation can be used in the current session/runtime. */
  available: boolean
  unavailableReason?: string
  actions: readonly GoalAction[]
  /** Whether authoritative state can be reconciled after reconnect/reload. */
  recovery: GoalRecovery
  /** Optional snapshot fields this implementation may report without fabrication. */
  optionalFields: readonly GoalOptionalField[]
}

export class GoalCapabilityError extends Error {
  readonly code = "goal_capability_unavailable"

  constructor(message: string) {
    super(message)
    this.name = "GoalCapabilityError"
  }
}

export function goalCapabilities(input: GoalCapabilities): GoalCapabilities {
  if (input.available && !input.implemented) {
    throw new GoalCapabilityError("A Goal implementation cannot be available when it is not implemented")
  }
  if (!input.available && !input.unavailableReason?.trim()) {
    throw new GoalCapabilityError("An unavailable Goal implementation must report unavailableReason")
  }
  if (new Set(input.actions).size !== input.actions.length) {
    throw new GoalCapabilityError("Goal actions must not contain duplicates")
  }
  if (new Set(input.optionalFields).size !== input.optionalFields.length) {
    throw new GoalCapabilityError("Goal optionalFields must not contain duplicates")
  }
  return input
}

export function goalActionAvailable(capabilities: GoalCapabilities, action: GoalAction): boolean {
  if (!capabilities.implemented || !capabilities.available) return false
  if (action === "pause" || action === "resume") {
    return capabilities.actions.includes("pause") && capabilities.actions.includes("resume")
  }
  return capabilities.actions.includes(action)
}

export function requireGoalAction(capabilities: GoalCapabilities, action: GoalAction): void {
  if (!goalActionAvailable(capabilities, action)) {
    throw new GoalCapabilityError(`Goal action '${action}' is not available`)
  }
}

export type AdapterCapabilityProvider = {
  readonly adapterCapabilities: readonly AdapterCapability[]
}

export type HttpProxyAdapter = AdapterCapabilityProvider & {
  // `getServerUrl` is valid in URL/spawn mode only (throws in injected mode).
  // `getRequestFn` is the transport-agnostic accessor kit proxies should use.
  getServerUrl(): Promise<string>
  getRequestFn(): Promise<OpenCodeRequestFn>
  /**
   * Whether a proxy can attach without paying a harness start.
   *
   * Long-lived compatibility streams are opened for the shell's benefit, not
   * because the user asked for harness work. A proxy that starts the harness to
   * serve one is why an idle desktop was never idle. Callers that only want to
   * ride an already-live transport check this first.
   */
  transportLive?(): boolean
  /**
   * Attach a stream that outlives the request that opened it, holding the
   * transport open until the returned lease is released. Without the lease the
   * idle countdown starts the moment the request returns and can tear the
   * harness down mid-stream.
   */
  acquireRequestFn?(): Promise<{ request: OpenCodeRequestFn; lease: ActivityLease }>
}

export type RuntimeConfigurableAdapter = AdapterCapabilityProvider & {
  setModel(model: string): void
  setAuth(keys: Record<string, string | undefined>): void
}

export function hasAdapterCapability<T extends AdapterCapability>(
  adapter: unknown,
  capability: T,
): adapter is AdapterCapabilityProvider & (
  T extends "http-proxy" ? HttpProxyAdapter : RuntimeConfigurableAdapter
) {
  if (!adapter || typeof adapter !== "object") return false
  const list = (adapter as { adapterCapabilities?: unknown }).adapterCapabilities
  return Array.isArray(list) && list.includes(capability)
}
