import type { SessionEnvFactory, SessionEnvFactoryInput } from "../session-env"
import type {
  AgentHarnessFactory,
} from "../runtime"
import type { RuntimeEventHub } from "../runtime-event-hub"
import type { AcpHarnessId, AgentHarnessAccess, AgentHarnessId } from "../harness-types"
import type { AgentRuntimeStoreWithRecovery } from "./shared/runtime-store"
import { AcpHarnessAdapter } from "./acp"
import { defaultAcpBinary as resolveAcpBinary } from "./acp/default-binaries"
import { ClaudeHarnessAdapter } from "./claude"
import { CodexHarnessAdapter } from "./codex"
import { CursorHarnessAdapter } from "./cursor"
import { OpenCodeHarnessAdapter } from "./opencode"
import { PiHarnessAdapter } from "./pi"

type NativeFactoryOptions = {
  access?: "native"
  binary?: string
}

type AcpFactoryOptions = {
  access: "acp"
  binary?: string
  args?: string[]
  env?: Record<string, string | undefined>
  createTransport?: unknown
}

type ClaudeFactoryOptions = NativeFactoryOptions | AcpFactoryOptions
type CodexFactoryOptions = NativeFactoryOptions | AcpFactoryOptions
type CursorFactoryOptions = NativeFactoryOptions | AcpFactoryOptions
type OpenCodeFactoryOptions = NativeFactoryOptions & {
  url?: string
  headers?: HeadersInit
}
type PiSessionPlacement = Omit<SessionEnvFactoryInput, "sessionId">
type PiFactoryOptions = {
  access?: "native"
  createEnv?: SessionEnvFactory
  defaultPlacement?: PiSessionPlacement | ((input: {
    sessionId: string
    directory: string | undefined
  }) => PiSessionPlacement | Promise<PiSessionPlacement>)
  permissionTimeoutMs?: number
}
type AgentHarnessFactoryContext = {
  store: AgentRuntimeStoreWithRecovery
  eventHub: RuntimeEventHub
}

export function claude(options: ClaudeFactoryOptions = {}): AgentHarnessFactory {
  return factory("claude", options.access ?? "native", (context) => {
    if (options.access === "acp") return acp("claude", options, context)
    return new ClaudeHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      ...(options.binary ? { binary: options.binary } : {}),
    })
  })
}

export function codex(options: CodexFactoryOptions = {}): AgentHarnessFactory {
  return factory("codex", options.access ?? "native", (context) => {
    if (options.access === "acp") return acp("codex", options, context)
    return new CodexHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      ...(options.binary ? { binary: options.binary } : {}),
    })
  })
}

export function cursor(options: CursorFactoryOptions = {}): AgentHarnessFactory {
  return factory("cursor", options.access ?? "native", (context) => {
    if (options.access === "acp") return acp("cursor", options, context)
    return new CursorHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      ...(options.binary ? { binary: options.binary } : {}),
    })
  })
}

export function opencode(options: OpenCodeFactoryOptions = {}): AgentHarnessFactory {
  return factory("opencode", "native", (context) => new OpenCodeHarnessAdapter(options.url, {
    eventHub: context.eventHub,
    ...(options.headers ? { headers: options.headers } : {}),
  }))
}

export function pi(options: PiFactoryOptions = {}): AgentHarnessFactory {
  return factory("pi", "native", (context) => new PiHarnessAdapter({
    ...options,
    eventHub: context.eventHub,
  }))
}

function factory(id: AgentHarnessId, access: AgentHarnessAccess, create: (context: AgentHarnessFactoryContext) => unknown): AgentHarnessFactory {
  return { id, access, create } as unknown as AgentHarnessFactory
}

function acp(id: AcpHarnessId, options: AcpFactoryOptions, context: AgentHarnessFactoryContext) {
  return new AcpHarnessAdapter({
    binary: options.binary ?? defaultAcpBinary(id),
    harness: id,
    store: context.store,
    eventHub: context.eventHub,
    ...(options.args ? { args: options.args } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.createTransport ? { createTransport: options.createTransport as ConstructorParameters<typeof AcpHarnessAdapter>[0]["createTransport"] } : {}),
  })
}

// The ACP bin NAME for a harness id. `resolveAcpBinary` turns the name into an
// absolute path to the shipped dependency (with a bare-name PATH fallback), so
// factory-composed ACP harnesses resolve the same binary as the kit registry
// path — no PATH symlink required.
const ACP_BIN_NAMES: Record<AcpHarnessId, string> = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
  cursor: "cursor-agent-acp",
}

function defaultAcpBinary(id: AcpHarnessId) {
  return resolveAcpBinary(ACP_BIN_NAMES[id])
}
