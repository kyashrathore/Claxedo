import type { SessionEnvFactory, SessionEnvFactoryInput } from "../session-env"
import type {
  AgentHarnessFactory,
} from "../runtime"
import type { RuntimeEventHub } from "../runtime-event-hub"
import { isAcpConnectionId, type AgentHarnessAccess, type SessionHarnessId } from "../harness-types"
import type { AgentRuntimeStoreWithRecovery } from "./shared/runtime-store"
import { AcpHarnessAdapter } from "./acp"
import { ClaudeHarnessAdapter } from "./claude"
import { CodexHarnessAdapter } from "./codex"
import { CursorHarnessAdapter } from "./cursor"
import { OpenCodeHarnessAdapter } from "./opencode"
import { PiHarnessAdapter } from "./pi"
import type { AgentProcessObserver } from "../process-observer"

type ProcessObservedFactoryOptions = {
  processObserver?: AgentProcessObserver
}

type NativeFactoryOptions = ProcessObservedFactoryOptions & {
  access?: "native"
  binary?: string
}

type AcpFactoryOptions = ProcessObservedFactoryOptions & {
  binary: string
  args?: string[]
  env?: Record<string, string | undefined>
  createTransport?: unknown
}

type ClaudeFactoryOptions = NativeFactoryOptions
type CodexFactoryOptions = NativeFactoryOptions
type CursorFactoryOptions = NativeFactoryOptions
type OpenCodeFactoryOptions = NativeFactoryOptions & {
  url?: string
  headers?: HeadersInit
}
type PiSessionPlacement = Omit<SessionEnvFactoryInput, "sessionId">
type PiFactoryOptions = ProcessObservedFactoryOptions & {
  access?: "native"
  createEnv?: SessionEnvFactory
  defaultPlacement?: PiSessionPlacement | ((input: {
    sessionId: string
    directory: string | undefined
  }) => PiSessionPlacement | Promise<PiSessionPlacement>)
}
type AgentHarnessFactoryContext = {
  store: AgentRuntimeStoreWithRecovery
  eventHub: RuntimeEventHub
}

export function claude(options: ClaudeFactoryOptions = {}): AgentHarnessFactory {
  return factory("claude", "native", (context) => new ClaudeHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      ...(options.binary ? { binary: options.binary } : {}),
      ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    }))
}

export function codex(options: CodexFactoryOptions = {}): AgentHarnessFactory {
  return factory("codex", "native", (context) => new CodexHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      ...(options.binary ? { binary: options.binary } : {}),
      ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    }))
}

export function cursor(options: CursorFactoryOptions = {}): AgentHarnessFactory {
  return factory("cursor", "native", (context) => new CursorHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      ...(options.binary ? { binary: options.binary } : {}),
      ...(options.processObserver ? { processObserver: options.processObserver } : {}),
    }))
}

export function acp(id: string, options: AcpFactoryOptions): AgentHarnessFactory {
  if (!isAcpConnectionId(id)) throw new Error(`Invalid ACP connection id: ${id}`)
  return factory(id, "acp", (context) => new AcpHarnessAdapter({
    binary: options.binary,
    harness: id,
    store: context.store,
    eventHub: context.eventHub,
    ...(options.args ? { args: options.args } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.createTransport ? { createTransport: options.createTransport as ConstructorParameters<typeof AcpHarnessAdapter>[0]["createTransport"] } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}

export function opencode(options: OpenCodeFactoryOptions = {}): AgentHarnessFactory {
  return factory("opencode", "native", (context) => new OpenCodeHarnessAdapter(options.url, {
    eventHub: context.eventHub,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.processObserver ? { processObserver: options.processObserver } : {}),
  }))
}

export function pi(options: PiFactoryOptions = {}): AgentHarnessFactory {
  return factory("pi", "native", (context) => new PiHarnessAdapter({
    ...options,
    eventHub: context.eventHub,
  }))
}

function factory(id: SessionHarnessId, access: AgentHarnessAccess, create: (context: AgentHarnessFactoryContext) => unknown): AgentHarnessFactory {
  return { id, access, create } as unknown as AgentHarnessFactory
}

/**
 * The lifecycle semantics every adapter shares.
 *
 * Exported from the harness barrel because an adapter living outside this
 * package still has to obey them — single-flight startup, lease-suspended idle
 * teardown, generation-scoped stops — and reimplementing them is how the five
 * in-tree adapters drifted apart in the first place.
 */
export {
  createProcessLifecycle,
  terminateOnParentLoss,
  ProcessLifecycleDisposedError,
  type ActivityLease,
  type ProcessLifecycle,
  type ProcessLifecycleEvent,
  type ProcessLifecycleOptions,
  type ProcessLifecycleState,
  type StopReason,
} from "./shared/process-lifecycle"
