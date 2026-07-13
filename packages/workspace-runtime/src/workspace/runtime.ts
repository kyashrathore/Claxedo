import fs from "fs"
import os from "os"
import path from "path"
import {
  AGENT_HARNESS_DEFINITIONS,
  createAgentRuntime,
  type AgentRuntime,
  type AgentHarnessFactory,
  type AgentRuntimeStore,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  harnessDefinition,
  type AgentHarnessId,
  type AgentSessionRow,
  type AgentSession,
  type AgentMessage,
  type AgentPermissionRow,
  type AgentQuestionRow,
  type SessionConfig,
  type SessionConfigUpdate,
  sdkModelConfigOption,
} from "@claxedo/agent-sdk-runtime"
import { applyRuntimeAgentExtensions } from "@claxedo/agent-extensions"
import {
  AcpHarnessAdapter,
  ClaudeHarnessAdapter,
  CodexHarnessAdapter,
  CursorHarnessAdapter,
  OpenCodeHarnessAdapter,
  PiHarnessAdapter,
  claudeAuthEnv,
  createStreamableHttpACPTransportFactory,
  createWebSocketACPTransportFactory,
  hasAdapterCapability,
  type AgentHarnessAdapter,
  type AgentHarnessAdapterHealth,
  type AgentRuntimeStoreWithRecovery,
  type HttpProxyAdapter,
  type OpenCodeRequestFn,
  type PiModelBackendResolver,
  type RuntimeConfigurableAdapter,
  defaultAcpBinary,
} from "@claxedo/agent-sdk-runtime/adapters"
import { attachSseFanout, createSseReplayBuffer, encodeSseData, sseHeaders } from "@claxedo/agent-sdk-runtime/sse"
import { isTerminalCompatEvent, type CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import type { Context, Hono } from "hono"
import { workspaceCapabilities } from "../capabilities"
import { runGit } from "../git"
import { createRuntimeEventHub, type RuntimeEventHub } from "../runtime-event-hub"
import { RuntimeStore } from "../store"
import { assertTarget, workspaceDir, type WorkspaceTarget } from "../target"
import { normalizeRuntimeSnapshot, RuntimeConfigApplyError, type AppliedRuntimeSnapshot, type RuntimeRunner, type RuntimeSnapshot } from "../routes/config"
import { assertWorkspaceRuntimeExposure } from "../exposure"
import { OpenCodeCompatRoutes } from "../routes/opencode-compat"
import { SessionRoutes } from "../routes/session"
import { sessionStatusSnapshot } from "../routes/session-status-snapshot"
import {
  mountWorkspaceAgentHooks,
  mountWorkspaceCore,
  mountWorkspaceProcess,
  mountWorkspacePty,
} from "./core"
import type { RuntimeConfigApplyStatus, WorkspaceHost, WorkspaceHostMountOptions } from "./host"

/**
 * The store surface the workspace-runtime engine actually consumes — derived
 * from the real calls in this file, NOT from the concrete `RuntimeStore` class.
 *
 * It is the harness-adapter store contract (`AgentRuntimeStoreWithRecovery`,
 * what each adapter's `createStore` must return) narrowed on the read methods
 * the engine's own session-config store path relies on (`getSession`,
 * `getMessages`), plus `getSessionMaxSeq` (used by the message-snapshot route).
 * `recoverBusySessions` is optional: the engine calls it on the adapter-owned
 * store when present (R2), so a host-supplied factory need not implement it. A
 * host may back the runtime with any store that satisfies this shape — e.g. the
 * in-memory store from `@claxedo/agent-sdk-runtime/stores/memory`.
 */
export type WorkspaceRuntimeStore =
  & Omit<AgentRuntimeStoreWithRecovery, "getSession" | "getMessages" | "bindSession" | "updateSessionConfig">
  & {
    getSession(id: string): AgentSession | null
    getMessages(id: string): AgentMessage[]
    getSessionMaxSeq(sessionId: string): number
    bindSession(input: {
      sessionId: string
      directory: string
      agentSessionId?: string
      title?: string
      ownerKey?: string
      createdAt?: number
    }): void
    updateSessionConfig(
      id: string,
      update: SessionConfigUpdate,
      input?: { directory?: string },
    ): SessionConfig | null | undefined
    recoverBusySessions?: () => unknown
    close?: () => void
  }

/**
 * Seam: a host-injected factory producing the runtime store for a given
 * `storeRoot`. The kit default constructs the SQLite-backed `RuntimeStore`.
 * The engine — not the factory — owns `recoverBusySessions()` on the
 * adapter-owned store (capability-checked) and the lazy/recovery-free
 * session-config store path (R2). The factory must be a pure constructor: it
 * receives `{ storeRoot }` and returns a fresh store; it must not itself run
 * recovery.
 */
export type WorkspaceRuntimeStoreFactory = (input: { storeRoot?: string }) => WorkspaceRuntimeStore

export type WorkspaceHostOptions = {
  opencodeUrl?: string
  /**
   * Injected in-process engine transport — a peer of `opencodeUrl`. When set,
   * the OpenCode adapter and the compat proxy routes dispatch every request
   * through this handler instead of a URL, and nothing spawns. The transport
   * seam (URL vs injected handler vs spawn) is kit MECHANISM; WHICH transport a
   * composition uses is a HOST decision — the kit never constructs an engine
   * and takes no ambient env into account. If both are given, the injected
   * handler wins.
   */
  opencodeRequest?: OpenCodeRequestFn
  opencodeHeaders?: HeadersInit
  /**
   * OpenCode compatibility control. Two independent things are gated: the
   * OpenCode adapter's own **mechanism** (its upstream `listSessions` /
   * `getStatusSnapshot` proxying, which is how the adapter actually functions),
   * and the root **compat route surface** (`/mcp`, `/provider`, `/vcs`,
   * `/session/status` proxying to the upstream). Three states:
   *
   * - `undefined` (default): adapter mechanism **on**, route surface **off**.
   *   The OpenCode adapter works (lists/statuses proxy upstream) but the
   *   product-facing compat routes return local fallbacks — a HOST decision.
   * - `true`: both on. Full OpenCode-compat, including the proxy route surface.
   * - `false`: both off. Full kill switch — the adapter returns empty/local
   *   results and never touches the upstream.
   *
   * HOST decision — the kit default is `undefined`; Claxedo decodes its compat
   * env flags into `true`/`false`.
   */
  opencodeCompat?: boolean
  /** Host-owned credential/model resolver for concrete Pi model turns. */
  piModelBackend?: PiModelBackendResolver
  harness?: RuntimeRunner
  target?: WorkspaceTarget
  storeRoot?: string
  eventHub?: RuntimeEventHub
  /**
   * Host-supplied store factory. Both the adapter-owned store (via each
   * adapter's `createStore`) and the lazy session-config store route through
   * it. Defaults to the SQLite-backed `RuntimeStore`. See
   * {@link WorkspaceRuntimeStoreFactory}.
   */
  storeFactory?: WorkspaceRuntimeStoreFactory
  /**
   * Host-supplied harness-adapter registry. `createAdapter` dispatches through
   * it (first matching entry wins). Defaults to
   * {@link defaultWorkspaceHarnessRegistry}. Must be STABLE for the host
   * lifetime — the engine caches adapters by `adapterKey` and owns config-apply
   * serialization and active-turn drain regardless of the registry (R2).
   */
  harnesses?: WorkspaceHarnessRegistry
}

const RUNNER_REPLACEMENT_DRAIN_TIMEOUT_MS = 1_000

type ActiveTurn = {
  sessionId: string
  directory: string
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

type RuntimeAuth = {
  anthropic?: string
  openai?: string
  cursor?: string
}
type AuthSlot = keyof RuntimeAuth

const NATIVE_HARNESS_ADAPTERS = {
  claude: ClaudeHarnessAdapter,
  codex: CodexHarnessAdapter,
  cursor: CursorHarnessAdapter,
} as const

const HARNESS_BINARY_FALLBACKS: Partial<Record<string, () => string>> = {
  "claude:acp": () => defaultAcpBinary("claude-agent-acp"),
  "codex:acp": () => defaultAcpBinary("codex-acp"),
  "cursor:acp": () => "agent",
  "codex:native": () => "codex",
}

const ACP_ARGS: Partial<Record<AgentHarnessId, string[]>> = {
  codex: ["-c", "service_tier=\"fast\""],
  cursor: ["acp"],
}

export const ACP_REMOTE_TRANSPORT_FLAG = "WORKSPACE_RUNTIME_ENABLE_ACP_REMOTE_TRANSPORT"

function acp(harness: RuntimeRunner) {
  return harness.access === "acp"
}

function nativeSdk(harness: RuntimeRunner): harness is RuntimeRunner & { id: keyof typeof NATIVE_HARNESS_ADAPTERS; access: "native" } {
  return harness.access === "native" && harness.id in NATIVE_HARNESS_ADAPTERS
}

function sessionRowConfigPatch(session: unknown) {
  const row = session && typeof session === "object" && !Array.isArray(session)
    ? session as { agent?: unknown; model?: unknown }
    : undefined
  const modelInput = row?.model
  const model = modelInput && typeof modelInput === "object" && !Array.isArray(modelInput)
    ? {
        providerID: typeof (modelInput as { providerID?: unknown }).providerID === "string"
          ? (modelInput as { providerID: string }).providerID
          : undefined,
        modelID: typeof (modelInput as { modelID?: unknown }).modelID === "string"
          ? (modelInput as { modelID: string }).modelID
          : typeof (modelInput as { id?: unknown }).id === "string"
            ? (modelInput as { id: string }).id
            : undefined,
        variant: typeof (modelInput as { variant?: unknown }).variant === "string"
          ? (modelInput as { variant: string }).variant
          : undefined,
      }
    : undefined
  return {
    ...(model?.providerID && model.modelID ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
    ...(model?.variant ? { variant: model.variant } : {}),
    ...(typeof row?.agent === "string" && row.agent ? { agent: row.agent } : {}),
  } satisfies Partial<SessionConfig>
}

function mergeRecoveredSessionConfig(config: SessionConfig, patch: Partial<SessionConfig>) {
  if (config.model && config.agent && config.variant !== undefined) return config
  const next = {
    ...config,
    ...(!config.model && patch.model ? { model: patch.model } : {}),
    ...((config.variant === undefined || config.variant === null) && patch.variant ? { variant: patch.variant } : {}),
    ...((config.agent === undefined || config.agent === null) && patch.agent ? { agent: patch.agent } : {}),
  }
  if (next === config || (next.model === config.model && next.agent === config.agent && next.variant === config.variant)) return config
  return next
}

function harnessKey(harness: RuntimeRunner) {
  return `${harness.id}:${harness.access}`
}

function processConnection(harness: RuntimeRunner) {
  const row = harness as RuntimeRunner & { binary?: string; args?: string[] }
  if (harness.connection?.kind === "process") return harness.connection
  if (typeof row.binary === "string") {
    return {
      kind: "process" as const,
      binary: row.binary,
      ...(Array.isArray(row.args) ? { args: row.args } : {}),
    }
  }
}

function remoteConnection(harness: RuntimeRunner) {
  const row = harness as RuntimeRunner & { transport?: unknown; url?: string; headers?: Record<string, string> }
  if (harness.connection?.kind === "remote") return harness.connection
  if (row.url || row.transport !== undefined || row.headers) {
    const transport = normalizeAgentHarnessTransport(row.transport)
    return {
      kind: "remote" as const,
      ...(transport ? { transport } : {}),
      ...(row.url ? { url: row.url } : {}),
      ...(row.headers ? { headers: row.headers } : {}),
    }
  }
}

function fallback(harness: RuntimeRunner) {
  return HARNESS_BINARY_FALLBACKS[harnessKey(harness)]?.() ?? defaultAcpBinary("claude-agent-acp")
}

function binary(harness: RuntimeRunner) {
  const raw = processConnection(harness)?.binary
  if (!raw) return fallback(harness)
  if (!raw.includes(path.sep)) return raw
  if (fs.existsSync(raw)) return raw
  return fallback(harness)
}

function acpArgs(harness: RuntimeRunner) {
  return [...(ACP_ARGS[harness.id] ?? []), ...(processConnection(harness)?.args ?? [])]
}

export function acpRemoteTransportEnabled(env: NodeJS.ProcessEnv = process.env) {
  return ["1", "true", "yes", "on"].includes(env[ACP_REMOTE_TRANSPORT_FLAG]?.trim().toLowerCase() ?? "")
}

export function acpTransportFactory(harness: RuntimeRunner, env: NodeJS.ProcessEnv = process.env) {
  const remote = remoteConnection(harness)
  if (!remote?.url) return
  if (!acpRemoteTransportEnabled(env)) return
  const transport = normalizeAgentHarnessTransport(remote.transport) ?? "streamable-http"
  if (transport === "websocket") {
    return createWebSocketACPTransportFactory({
      serverUrl: remote.url,
      headers: remote.headers,
    })
  }
  if (transport === "stdio") return
  return createStreamableHttpACPTransportFactory({
    serverUrl: remote.url,
    headers: remote.headers,
  })
}

function acpEnv(harness: RuntimeRunner, auth: Record<string, string>) {
  const definition = harnessDefinition(harness)
  if (definition?.access !== "acp" || !definition.authEnv || !definition.authSlot) return {}
  if (definition.authSlot === "anthropic") {
    return claudeAuthEnv(auth[definition.key] ?? auth[definition.authSlot])
  }
  const input = definition.authSlot === "openai"
    ? codexAuthInput(auth)
    : auth[definition.key] ?? auth[definition.authSlot]
  const value = definition.authSlot === "openai" ? runtimeAuthKey(input) : input
  if (!value) return {}
  return { [definition.authEnv]: value }
}

function authSlotValue(auth: Record<string, string>, slot: AuthSlot) {
  const candidates = AGENT_HARNESS_DEFINITIONS
    .filter((item) => item.authSlot === slot)
    .map((item) => auth[item.key])
  return candidates.find(Boolean) ?? auth[slot]
}

function runtimeAuthInput(auth: Record<string, string>, slot: AuthSlot) {
  if (slot === "openai") return codexAuthInput(auth)
  return authSlotValue(auth, slot)
}

function runtimeAuthForAdapter(nextAuth: RuntimeAuth) {
  return {
    anthropic: nextAuth.anthropic,
    openai: nextAuth.openai,
    cursor: nextAuth.cursor,
  }
}

function json(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    return value && typeof value === "object" ? value : undefined
  } catch {}
}

function errorMessage(input: unknown) {
  if (input instanceof Error) return input.message
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const row = input as Record<string, unknown>
    const data = row.data
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const dataMessage = (data as Record<string, unknown>).message
      if (typeof dataMessage === "string") return dataMessage
    }
    if (typeof row.message === "string") return row.message
    try {
      return JSON.stringify(input)
    } catch {}
  }
  return String(input)
}

function harnessConfigOptionsErrorMessage(input: {
  harness: RuntimeRunner
  cause: unknown
}) {
  const message = errorMessage(input.cause)
  if (input.harness.id === "codex" && input.harness.access === "acp" && message.startsWith("ACP connection closed")) {
    const detail = message.replace(/^ACP connection closed:?\s*/, "").replace(/^Error:\s*/, "")
    if (detail) return `Codex could not start: ${detail}. Run \`codex doctor\`, fix the reported Codex config/auth issue, then retry.`
    return "Codex could not start. Run `codex doctor`, fix the reported Codex config/auth issue, then retry."
  }
  return message
}

function agentExtensionApplyFailureReason(input: unknown) {
  const message = errorMessage(input).toLowerCase()
  if (message.includes("unsupported agent extension source")) return "unsupported_source"
  if (message.includes("package path must stay inside")) return "invalid_package_path"
  if (message.includes("missing resolved sha")) return "missing_resolved_sha"
  if (message.includes("checksum mismatch")) return "checksum_mismatch"
  if (message.includes("root does not exist")) return "project_root_missing"
  return "materialization_failed"
}

async function applyAgentExtensionsSnapshot(snapshot: AppliedRuntimeSnapshot["agent_extensions"], directory: string) {
  try {
    await applyRuntimeAgentExtensions(snapshot, directory)
  } catch (cause) {
    throw new RuntimeConfigApplyError(
      "runtime_config_agent_extensions_apply_failed",
      "Runtime agent extension snapshot replay failed",
      500,
      { reason: agentExtensionApplyFailureReason(cause) },
    )
  }
}

function runtimeConfigApplyRoot(directory: string) {
  return path.join(directory, ".workspace-runtime", "runtime-config")
}

function runtimeConfigSnapshotMetadata(snapshot: AppliedRuntimeSnapshot) {
  return {
    version: snapshot.version,
    harness: snapshot.harness,
    ...(typeof snapshot.model === "string" ? { model: snapshot.model } : {}),
    mcp: { keys: Object.keys(snapshot.mcp).sort() },
    auth: { keys: Object.keys(snapshot.auth).sort() },
    ...(snapshot.agent_extensions ? {
      agent_extensions: {
        version: snapshot.agent_extensions.version,
        installCount: snapshot.agent_extensions.installs.length,
        installIds: snapshot.agent_extensions.installs
          .map((install) => install.desired.id)
          .filter((id): id is string => typeof id === "string")
          .sort(),
      },
    } : {}),
    ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
    ...(snapshot.commands ? { commands: snapshot.commands.map((command) => command.name).sort() } : {}),
  }
}

async function persistRuntimeConfigApplyStatus(input: {
  directory: string
  status: RuntimeConfigApplyStatus
  snapshot?: AppliedRuntimeSnapshot
}) {
  try {
    const root = runtimeConfigApplyRoot(input.directory)
    await fs.promises.mkdir(root, { recursive: true, mode: 0o755 })
    if (input.snapshot) {
      await fs.promises.writeFile(
        path.join(root, "accepted-snapshot.json"),
        JSON.stringify({
          revision: input.status.revision,
          acceptedAt: input.status.acceptedAt,
          snapshot: runtimeConfigSnapshotMetadata(input.snapshot),
        }, null, 2) + "\n",
        { mode: 0o600 },
      )
    }
    await fs.promises.writeFile(
      path.join(root, "apply-status.json"),
      JSON.stringify(input.status, null, 2) + "\n",
      { mode: 0o600 },
    )
  } catch {
    throw new RuntimeConfigApplyError(
      "runtime_config_apply_status_persist_failed",
      "Runtime config apply status could not be persisted",
      500,
    )
  }
}

function runtimeConfigApplyError(input: unknown): RuntimeConfigApplyStatus["error"] {
  if (input instanceof RuntimeConfigApplyError) {
    return {
      code: input.code,
      message: input.message,
      ...(input.details ? { details: input.details } : {}),
    }
  }
  return {
    code: "runtime_snapshot_apply_failed",
    message: "Runtime config apply failed",
  }
}

function codexAuthInput(auth: Record<string, string>) {
  return auth["codex-app-server"] ?? auth["codex-acp"] ?? auth["openai"]
}

function codexAuthValue(input: string | undefined) {
  const value = json(input)
  if (!value) return
  const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens as Record<string, unknown> : undefined
  if (value.type === "codex_auth") return value
  if (
    typeof value.auth_mode === "string"
    && typeof tokens?.access_token === "string"
    && typeof tokens?.refresh_token === "string"
    && typeof tokens?.account_id === "string"
  ) return { ...value, type: "codex_auth" as const }
}

export function runtimeAuthKey(input: string | undefined) {
  const value = codexAuthValue(input)
  if (!value) return input || undefined
  return typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY : undefined
}

export async function materializeCodexAuth(input: string | undefined) {
  const value = codexAuthValue(input)
  if (!value) return
  const oauth = value.oauth && typeof value.oauth === "object" ? value.oauth as Record<string, unknown> : undefined
  const row = value.tokens && typeof value.tokens === "object" ? value.tokens as Record<string, unknown> : undefined
  const access = typeof row?.access_token === "string" ? row.access_token : typeof oauth?.access === "string" ? oauth.access : undefined
  const refresh = typeof row?.refresh_token === "string" ? row.refresh_token : typeof oauth?.refresh === "string" ? oauth.refresh : undefined
  const account = typeof row?.account_id === "string" ? row.account_id : typeof oauth?.account_id === "string" ? oauth.account_id : undefined
  if (!access || !refresh || !account) return
  const dir = path.join(os.homedir(), ".codex")
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.promises.writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({
      auth_mode: typeof value.auth_mode === "string" ? value.auth_mode : "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        ...(typeof row?.id_token === "string" ? { id_token: row.id_token } : {}),
        access_token: access,
        refresh_token: refresh,
        account_id: account,
      },
      last_refresh: typeof value.last_refresh === "string" ? value.last_refresh : new Date().toISOString(),
    }, null, 2) + "\n",
    { mode: 0o600 },
  )
}

async function materialize(auth: Record<string, string>) {
  await materializeCodexAuth(codexAuthInput(auth))
}

const defaultStoreFactory: WorkspaceRuntimeStoreFactory = ({ storeRoot }) => new RuntimeStore(storeRoot)

function resolveStoreFactory(options: WorkspaceHostOptions): WorkspaceRuntimeStoreFactory {
  return options.storeFactory ?? defaultStoreFactory
}

/**
 * The `createStore` closure handed to each harness adapter. It routes store
 * construction through the already-resolved host store factory and, on the
 * adapter-owned path, runs `recoverBusySessions()` (capability-checked) as an
 * ENGINE step — the factory itself never needs to remember recovery (R2).
 */
function adapterCreateStore(factory: WorkspaceRuntimeStoreFactory): (storeRoot?: string) => AgentRuntimeStoreWithRecovery {
  return (storeRoot?: string) => {
    const store = factory({ storeRoot })
    store.recoverBusySessions?.()
    return store
  }
}

/** Input handed to a registry entry's `create` when the engine builds an adapter. */
export type WorkspaceHarnessAdapterInput = {
  /** The runner the engine wants an adapter for. */
  runner: RuntimeRunner
  /** The host options the engine was constructed with. */
  options: WorkspaceHostOptions
}

/**
 * One catalog entry: a predicate on the runner and the adapter constructor to
 * use when it matches. Entries are consulted in order; the first match wins.
 */
export type WorkspaceHarnessRegistryEntry = {
  /** Selects this entry when it returns true for the requested runner. */
  match: (runner: RuntimeRunner) => boolean
  /** Constructs the adapter. The engine owns everything around this call —
   *  caching (adapterKey), config-apply serialization, active-turn drain, and
   *  `recoverBusySessions` on the adapter-owned store — regardless of the
   *  registry (R2). */
  create: (input: WorkspaceHarnessAdapterInput) => AgentHarnessAdapter
}

/**
 * A harness-adapter registry: an ordered list of entries the engine dispatches
 * through in {@link createAdapter}. It must be STABLE for the host lifetime —
 * the engine caches adapters by `adapterKey` and reuses them across turns, so a
 * registry that changes between calls would produce inconsistent adapters for
 * the same runner. The kit default is {@link defaultWorkspaceHarnessRegistry};
 * a host may supply its own via `WorkspaceHostOptions.harnesses`.
 */
export type WorkspaceHarnessRegistry = WorkspaceHarnessRegistryEntry[]

/**
 * The built-in adapter catalog. Selection semantics are byte-identical to the
 * previous closed switch: ACP (any `access: "acp"` runner) → native
 * claude/codex/cursor SDK adapters → Pi → OpenCode. The final OpenCode entry
 * matches everything, so it is both the `opencode` runner's adapter AND the
 * fallthrough for any unknown runner — preserving today's "unknown → OpenCode"
 * behavior. The ACP binary fallback (`defaultAcpBinary`) is applied through the
 * shared `binary()`/`acpArgs()` helpers.
 */
export function defaultWorkspaceHarnessRegistry(): WorkspaceHarnessRegistry {
  return [
    {
      match: (runner) => acp(runner),
      create: ({ runner, options }) => {
        const createTransport = acpTransportFactory(runner)
        return new AcpHarnessAdapter({
          binary: binary(runner),
          harness: runner.id === "opencode" || runner.id === "pi" ? "claude" : runner.id,
          args: acpArgs(runner),
          ...(createTransport ? { createTransport } : {}),
          createStore: adapterCreateStore(resolveStoreFactory(options)),
          ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}),
          ...(options.eventHub ? { eventHub: options.eventHub } : {}),
        })
      },
    },
    {
      match: (runner) => nativeSdk(runner),
      create: ({ runner, options }) => {
        const Adapter = NATIVE_HARNESS_ADAPTERS[runner.id as keyof typeof NATIVE_HARNESS_ADAPTERS]
        return new Adapter({
          ...(processConnection(runner)?.binary || HARNESS_BINARY_FALLBACKS[harnessKey(runner)] ? { binary: binary(runner) } : {}),
          createStore: adapterCreateStore(resolveStoreFactory(options)),
          ...(options.storeRoot ? { storeRoot: options.storeRoot } : {}),
          ...(options.eventHub ? { eventHub: options.eventHub } : {}),
        })
      },
    },
    {
      match: (runner) => runner.id === "pi",
      create: ({ options }) => new PiHarnessAdapter({
        ...(options.eventHub ? { eventHub: options.eventHub } : {}),
        ...(options.piModelBackend ? { modelBackend: options.piModelBackend } : {}),
      }),
    },
    {
      match: () => true,
      create: ({ options }) => new OpenCodeHarnessAdapter(options.opencodeUrl, {
        ...(options.opencodeHeaders ? { headers: options.opencodeHeaders } : {}),
        ...(options.opencodeRequest ? { request: options.opencodeRequest } : {}),
        eventHub: options.eventHub,
        // Adapter mechanism (upstream list/status proxying) stays on unless the
        // host explicitly opts out. The root compat ROUTE surface is separately
        // gated by `!== true` below. See WorkspaceHostOptions.opencodeCompat.
        compat: options.opencodeCompat !== false,
      }),
    },
  ]
}

function resolveHarnessRegistry(options: WorkspaceHostOptions): WorkspaceHarnessRegistry {
  return options.harnesses ?? defaultWorkspaceHarnessRegistry()
}

function createAdapter(
  harness: RuntimeRunner,
  options: WorkspaceHostOptions,
  registry: WorkspaceHarnessRegistry,
): AgentHarnessAdapter {
  const entry = registry.find((item) => item.match(harness))
  if (!entry) {
    // The default registry ends with a catch-all, so this only happens when a
    // host supplies a registry with no matching entry for the runner.
    throw new Error(`No workspace harness adapter registered for runner "${harness.id}:${harness.access}"`)
  }
  return entry.create({ runner: harness, options })
}

function closedSse() {
  return new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.close()
    },
  }), {
    headers: sseHeaders(),
  })
}

function opencodeProxyHeaders(headers: HeadersInit, base?: HeadersInit) {
  const next = new Headers(headers)
  next.delete("host")
  next.delete("connection")
  next.delete("authorization")
  next.delete("Authorization")
  next.delete("x-workspace-id")
  next.delete("x-forwarded-by")
  if (base) {
    new Headers(base).forEach((value, key) => next.set(key, value))
  }
  return next
}

// Synthetic origin for proxy Requests. The adapter's RequestFn rewrites this to
// the real server URL (URL/spawn mode) or routes on path only (injected mode).
const OPENCODE_INTERNAL_BASE = "http://opencode.internal"

async function proxyOpenCode(c: any, adapter: AgentHarnessAdapter, baseHeaders?: HeadersInit) {
  if (!hasAdapterCapability(adapter, "http-proxy")) return
  const request = await (adapter as AgentHarnessAdapter & HttpProxyAdapter).getRequestFn()
  const reqUrl = new URL(c.req.url)
  const target = new URL(reqUrl.pathname + reqUrl.search, OPENCODE_INTERNAL_BASE)
  const headers = opencodeProxyHeaders(c.req.raw.headers, baseHeaders)
  const directory = c.req.query("directory") || c.req.header("x-opencode-directory")
  if (directory) headers.set("x-opencode-directory", assertTarget(directory))
  const req = new Request(target.toString(), {
    method: c.req.method,
    headers,
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
    // @ts-ignore
    duplex: "half",
  })
  const res = await request(req)
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

async function proxyOpenCodeOrJson(c: any, adapter: AgentHarnessAdapter, fallback: () => Promise<unknown> | unknown, baseHeaders?: HeadersInit) {
  try {
    const res = await proxyOpenCode(c, adapter, baseHeaders)
    if (res?.ok) return res
  } catch {}
  return c.json(await fallback())
}

function providerListHasModels(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const all = (input as { all?: unknown }).all
  if (!Array.isArray(all)) return false
  return all.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false
    const models = (item as { models?: unknown }).models
    return !!models && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length > 0
  })
}

function providerUnavailable(harness: RuntimeRunner) {
  return {
    ok: false,
    error: {
      code: "provider_models_unavailable",
      harness: harness.id,
      message: `${harness.id} does not expose live provider model metadata`,
    },
  }
}

function requestDirectory(c: any) {
  return assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory") || workspaceDir())
}

async function gitLine(directory: string, args: string[]) {
  try {
    return (await runGit(args, directory)).trim() || undefined
  } catch {
    return undefined
  }
}

async function localVcsInfo(directory: string) {
  const [branch, remoteHead] = await Promise.all([
    gitLine(directory, ["branch", "--show-current"]),
    gitLine(directory, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
  ])
  return {
    ...(branch ? { branch } : {}),
    ...(remoteHead ? { default_branch: remoteHead.replace(/^origin\//, "") } : {}),
  }
}

function mcpStatus(config: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(config).map((name) => [name, { status: "disabled" }]))
}

function runtimeAuth(auth: Record<string, string>): RuntimeAuth {
  return {
    anthropic: runtimeAuthKey(runtimeAuthInput(auth, "anthropic")),
    openai: runtimeAuthKey(runtimeAuthInput(auth, "openai")),
    cursor: runtimeAuthKey(runtimeAuthInput(auth, "cursor")),
  }
}

function sameRuntimeAuth(a: RuntimeAuth, b: RuntimeAuth) {
  return a.anthropic === b.anthropic && a.openai === b.openai && a.cursor === b.cursor
}

function sameRuntimeMcp(a: Record<string, unknown>, b: Record<string, unknown>) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createWorkspaceHost(options: WorkspaceHostOptions = {}): WorkspaceHost {
  const eventHub = options.eventHub ?? createRuntimeEventHub()
  const globalEventReplay = createSseReplayBuffer<CompatEnvelope>({
    isTerminal: (event) => isTerminalCompatEvent(event.payload),
  })
  const cleanupGlobalEventReplay = eventHub.subscribeGlobal((event) => {
    globalEventReplay.push(event)
  })
  const hostOptions = { ...options, eventHub }
  let runner = options.harness ?? { id: "opencode" as const, access: "native" as const }
  let state: "ready" | "applying" | "error" = "ready"
  let err = ""
  let enabled = false
  let configApplyRevision = 0
  let configApply: RuntimeConfigApplyStatus = { state: "idle", revision: 0 }
  let adapter: AgentHarnessAdapter | undefined
  let currentMcp: Record<string, unknown> = {}
  let currentAuth: RuntimeAuth = {}
  let currentAuthRaw: Record<string, string> = {}
  let applyQueue = Promise.resolve()
  const storeFactory = resolveStoreFactory(options)
  // Resolved once and reused: the registry must be stable for the host lifetime
  // (adapter cache identity depends on it — R2).
  const harnessRegistry = resolveHarnessRegistry(options)
  let sessionConfigStore: WorkspaceRuntimeStore | undefined
  const sessionAdapters = new Map<string, AgentHarnessAdapter>()
  const sessionRuntimes = new Map<string, AgentRuntime>()
  const sessionAdapterRunners = new Map<string, RuntimeRunner>()
  const adapterConfigStamps = new WeakMap<AgentHarnessAdapter, string>()
  const activeTurns = new Map<AgentHarnessAdapter, Set<ActiveTurn>>()

  function adapterKey(next: RuntimeRunner) {
    const process = processConnection(next)
    const remote = remoteConnection(next)
    return `${next.id}\n${next.access}\n${process?.binary ?? ""}\n${process?.args?.join("\0") ?? ""}\n${remote?.transport ?? ""}\n${remote?.url ?? ""}\n${JSON.stringify(remote?.headers ?? {})}`
  }

  function runnerFromAdapterKey(key: string) {
    const [id, access, binary, args, transport, url, headers] = key.split("\n")
    const identity = normalizeHarnessIdentity({ id, access })
    const connection = url || headers || transport
      ? {
          kind: "remote" as const,
          ...(transport ? { transport: normalizeAgentHarnessTransport(transport) } : {}),
          ...(url ? { url } : {}),
          ...(headers ? { headers: JSON.parse(headers) as Record<string, string> } : {}),
        }
      : binary || args
        ? {
            kind: "process" as const,
            ...(binary ? { binary } : {}),
            ...(args ? { args: args.split("\0").filter(Boolean) } : {}),
          }
        : undefined
    return {
      id: identity?.id ?? "opencode",
      access: identity?.access ?? "native",
      ...(connection ? { connection } : {}),
    }
  }

  async function configureAdapter(next: AgentHarnessAdapter, nextRunner: RuntimeRunner, model?: string) {
    if (!hasAdapterCapability(next, "runtime-config") || !next.applyConfig) return
    if (
      model === undefined
      && Object.keys(currentAuthRaw).length === 0
      && Object.keys(currentMcp).length === 0
      && adapterConfigStamps.get(next) === undefined
    ) {
      adapterConfigStamps.set(next, `${adapterKey(nextRunner)}\n\n{}\n{}`)
      return
    }
    const stamp = `${adapterKey(nextRunner)}\n${model ?? ""}\n${JSON.stringify(currentAuthRaw)}\n${JSON.stringify(currentMcp)}`
    if (adapterConfigStamps.get(next) === stamp) return
    ;(next as AgentHarnessAdapter & RuntimeConfigurableAdapter).setAuth(
      acp(nextRunner)
        ? acpEnv(nextRunner, currentAuthRaw)
        : runtimeAuthForAdapter(currentAuth),
    )
    if (model && model !== "default") {
      ;(next as AgentHarnessAdapter & RuntimeConfigurableAdapter).setModel(model)
    }
    await next.applyConfig({
      mcp: currentMcp,
      auth: currentAuthRaw,
      harness: nextRunner,
      model,
    })
    adapterConfigStamps.set(next, stamp)
  }

  function ensure() {
    if (adapter) return adapter
    adapter = createAdapter(runner, hostOptions, harnessRegistry)
    enabled = true
    return adapter
  }

  async function ensureSessionAdapter(nextRunner: RuntimeRunner) {
    if (adapterKey(nextRunner) === adapterKey(runner)) {
      const next = ensure()
      await configureAdapter(next, nextRunner)
      return next
    }
    const key = adapterKey(nextRunner)
    const existing = sessionAdapters.get(key)
    if (existing) {
      sessionAdapterRunners.set(key, nextRunner)
      await configureAdapter(existing, nextRunner)
      return existing
    }
    const next = createAdapter(nextRunner, hostOptions, harnessRegistry)
    sessionAdapters.set(key, next)
    sessionAdapterRunners.set(key, nextRunner)
    enabled = true
    await configureAdapter(next, nextRunner)
    return next
  }

  function sessionConfigFor(input?: { sessionId?: string; directory?: string }) {
    if (!input?.sessionId) return
    const config = store().getSessionConfig(input.sessionId)
    if (!config || !input.directory) return config
    const session = store().getSession(input.sessionId) as { directory?: string } | null
    if (session?.directory && session.directory !== input.directory) return
    return config
  }

  async function adapterForSession(input?: { sessionId?: string; directory?: string; harness?: RuntimeRunner }) {
    if (!input?.sessionId) {
      if (input?.harness) return await ensureSessionAdapter(input.harness)
      return ensure()
    }
    const config = sessionConfigFor(input)
    if (!config) return input?.harness ? await ensureSessionAdapter(input.harness) : ensure()
    return await ensureSessionAdapter(config.harness)
  }

  async function runtimeForSession(input?: { sessionId?: string; directory?: string; harness?: RuntimeRunner }) {
    const config = sessionConfigFor(input)
    const nextRunner = config?.harness ?? input?.harness ?? runner
    if (input?.sessionId && !config) {
      if (!store().getSession(input.sessionId)) {
        store().bindSession({
          sessionId: input.sessionId,
          directory: input.directory ?? input.sessionId,
          agentSessionId: input.sessionId,
        })
      }
      store().updateSessionConfig(input.sessionId, {
        harness: nextRunner,
        variant: null,
        agent: null,
      })
    }
    const key = adapterKey(nextRunner)
    const existing = sessionRuntimes.get(key)
    if (existing) return existing
    const nextAdapter = await ensureSessionAdapter(nextRunner)
    const runtime = createAgentRuntime({
      store: store() as unknown as AgentRuntimeStore,
      harnesses: [{
        id: nextRunner.id,
        access: nextRunner.access,
        create: () => nextAdapter,
      } as unknown as AgentHarnessFactory],
    })
    sessionRuntimes.set(key, runtime)
    return runtime
  }

  async function listSessions(input: {
    req: { query: (k: string) => string | undefined }
  }, directory: string) {
    const requestedRunner = normalizeHarnessIdentity(input.req.query("harness") || input.req.query("runner") || undefined)
    if (requestedRunner) {
      const target: RuntimeRunner = {
        id: requestedRunner.id,
        access: requestedRunner.access,
      }
      return await listSessionsForAdapter(await ensureSessionAdapter(target), target, directory)
    }
    const rows = await Promise.all((await sessionListAdapters()).map((item) => listSessionsForAdapter(item.adapter, item.runner, directory)))
    return mergeSessionRows([
      ...(store().listSessions(directory) as AgentSessionRow[]),
      ...rows.flat(),
    ])
  }

  async function sessionListAdapters() {
    const seen = new Set<string>()
    const add = (items: Array<{ adapter: AgentHarnessAdapter; runner: RuntimeRunner }>, next: {
      adapter: AgentHarnessAdapter
      runner: RuntimeRunner
    }) => {
      const key = adapterKey(next.runner)
      if (seen.has(key)) return
      seen.add(key)
      items.push(next)
    }
    const items: Array<{ adapter: AgentHarnessAdapter; runner: RuntimeRunner }> = []
    add(items, { adapter: ensure(), runner })
    for (const [key, item] of sessionAdapters) {
      add(items, { adapter: item, runner: sessionAdapterRunners.get(key) ?? runnerFromAdapterKey(key) })
    }
    if (runner.id !== "opencode") {
      const opencode = { id: "opencode" as const, access: "native" as const }
      add(items, { adapter: await ensureSessionAdapter(opencode), runner: opencode })
    }
    return items
  }

  async function listSessionsForAdapter(adapter: AgentHarnessAdapter, targetRunner: RuntimeRunner, directory: string) {
    return (await adapter.listSessions(directory)).map((session) => bindDiscoveredSession(session, targetRunner, directory))
  }

  function bindDiscoveredSession(session: AgentSessionRow, targetRunner: RuntimeRunner, directory: string) {
    const id = typeof session.id === "string" ? session.id : undefined
    if (!id) return session
    const existing = store().getSession(id) as { time?: { updated?: number }; updated_at?: number } | null
    if (!existing) {
      store().bindSession({
        sessionId: id,
        directory,
        title: typeof session.title === "string" ? session.title : undefined,
        agentSessionId: id,
        createdAt: sessionTime(session, "created") ?? Date.now(),
      })
    }
    if (!store().getSessionConfig(id) && (!existing || sessionTime(session, "updated") >= sessionTime(existing, "updated"))) {
      store().updateSessionConfig(id, {
        harness: targetRunner,
        variant: null,
        agent: null,
      }, { directory })
    }
    return session
  }

  function mergeSessionRows(rows: AgentSessionRow[]) {
    return [...rows.reduce((acc, row) => {
      const prev = acc.get(row.id)
      if (!prev || sessionTime(row, "updated") >= sessionTime(prev, "updated")) acc.set(row.id, row)
      return acc
    }, new Map<string, AgentSessionRow>()).values()]
      .sort((a, b) => sessionTime(b, "updated") - sessionTime(a, "updated"))
  }

  function sessionTime(input: unknown, key: "created" | "updated") {
    const rec = input && typeof input === "object" ? input as Record<string, unknown> : {}
    const time = rec.time && typeof rec.time === "object" ? rec.time as Record<string, unknown> : {}
    const camel = time[key]
    if (typeof camel === "number") return camel
    const snake = rec[`${key}_at`]
    return typeof snake === "number" ? snake : 0
  }

  async function listPermissions(input: {
    req: { query: (k: string) => string | undefined }
  }, directory: string) {
    const sessionId = input.req.query("sessionId")
    if (sessionId) return await (await adapterForSession({ sessionId })).listPermissions?.(directory) ?? []
    const seen = new Set<AgentHarnessAdapter>()
    return (await Promise.all(
      [adapter, ...sessionAdapters.values()]
        .filter((item): item is AgentHarnessAdapter => !!item)
        .filter((item) => {
          if (seen.has(item)) return false
          seen.add(item)
          return true
        })
        .map((item) => item.listPermissions?.(directory) ?? Promise.resolve([])),
    )).flat() as AgentPermissionRow[]
  }

  async function listQuestions(input: {
    req: { query: (k: string) => string | undefined }
  }, directory: string) {
    const sessionId = input.req.query("sessionId")
    if (sessionId) return await (await adapterForSession({ sessionId, directory })).listQuestions?.(directory) ?? []
    const seen = new Set<AgentHarnessAdapter>()
    return (await Promise.all(
      [adapter, ...sessionAdapters.values()]
        .filter((item): item is AgentHarnessAdapter => !!item)
        .filter((item) => {
          if (seen.has(item)) return false
          seen.add(item)
          return true
        })
        .map((item) => item.listQuestions?.(directory) ?? Promise.resolve([])),
    )).flat() as AgentQuestionRow[]
  }

  function clear() {
    adapter?.dispose()
    if (adapter) activeTurns.delete(adapter)
    adapter = undefined
    sessionRuntimes.clear()
  }

  function store() {
    // Recovery-free by design: the session-config store never runs
    // recoverBusySessions (only the adapter-owned path does). Routes through
    // the host-supplied factory, defaulting to the SQLite RuntimeStore.
    sessionConfigStore ??= storeFactory({ storeRoot: options.storeRoot })
    return sessionConfigStore
  }

  function createActiveTurnScope(input: { adapter: AgentHarnessAdapter; directory: string; sessionId: string }) {
    let finish = () => {}
    const turn = {
      sessionId: input.sessionId,
      directory: input.directory,
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
      finish: () => finish(),
    }
    const turns = activeTurns.get(input.adapter) ?? new Set<ActiveTurn>()
    turns.add(turn)
    activeTurns.set(input.adapter, turns)
    return {
      signal: turn.controller.signal,
      dispose() {
        turns.delete(turn)
        turn.finish()
        if (turns.size === 0) activeTurns.delete(input.adapter)
      },
    }
  }

  async function drainActiveTurns(next: AgentHarnessAdapter) {
    const turns = activeTurns.get(next)
    if (!turns?.size) return
    const pending = [...turns]
    for (const turn of pending) turn.controller.abort()
    const aborts = next.abort
      ? pending.map((turn) => next.abort!(turn.sessionId, turn.directory).catch(() => {}))
      : []
    const drained = Promise.all([...aborts, ...pending.map((turn) => turn.done)])
    await Promise.race([
      drained,
      new Promise((resolve) => setTimeout(resolve, RUNNER_REPLACEMENT_DRAIN_TIMEOUT_MS)),
    ])
  }

  function runnerHealth(): AgentHarnessAdapterHealth {
    return adapter?.readRuntimeHealth?.(options.target?.directory ?? workspaceDir()) ?? { status: "ok" }
  }

  function healthStatus(input: AgentHarnessAdapterHealth): "ok" | "degraded" | "unavailable" {
    if (state === "error") return "unavailable"
    if (state === "applying") return "degraded"
    return input.status
  }

  async function applySnapshot(next: AppliedRuntimeSnapshot) {
    state = "applying"
    enabled = next.workspaceHarnessEnabled ?? enabled
    const directory = options.target?.directory ?? workspaceDir()
    let revision = configApplyRevision
    let acceptedAt: string | undefined
    const replacing = adapterKey(next.harness) !== adapterKey(runner)
    const nextAuth = runtimeAuth(next.auth)
    const unsafeAcpLiveConfigChange = !replacing
      && adapter
      && acp(runner)
      && hasAdapterCapability(adapter, "runtime-config")
      && (activeTurns.get(adapter)?.size ?? 0) > 0
      && (
        next.model !== undefined
        || !sameRuntimeAuth(currentAuth, nextAuth)
        || !sameRuntimeMcp(currentMcp, next.mcp)
      )

    try {
      if (unsafeAcpLiveConfigChange) {
        throw new RuntimeConfigApplyError(
          "runtime_config_unsafe_restart",
          "ACP runtime config change would restart an active session",
          409,
          {
            harness: runner.id,
            activeTurns: adapter ? activeTurns.get(adapter)?.size ?? 0 : 0,
          },
        )
      }
      revision = configApplyRevision + 1
      acceptedAt = new Date().toISOString()
      configApplyRevision = revision
      configApply = {
        state: "applying",
        revision,
        acceptedAt,
        updatedAt: acceptedAt,
        harness: next.harness,
      }
      await persistRuntimeConfigApplyStatus({ directory, status: configApply, snapshot: next })
      await materialize(next.auth)
      // Do not materialize central slash commands pushed via
      // the runtime config push — the runner-host owns command discovery
      // and re-writing them at the workspace layer would clobber any
      // user-authored commands that already live on disk.
      // (See workspace/runtime.test.ts: "runtime config push does not
      // materialize central slash commands".)
      currentMcp = next.mcp
      currentAuth = nextAuth
      currentAuthRaw = next.auth

      if (replacing) {
        if (adapter) await drainActiveTurns(adapter)
        clear()
        runner = next.harness
      }

      if (!replacing && adapter && hasAdapterCapability(adapter, "runtime-config") && next.model !== undefined) {
        ;(adapter as AgentHarnessAdapter & RuntimeConfigurableAdapter).setModel(
          next.model === "default" ? "" : next.model,
        )
      }

      if (adapter && hasAdapterCapability(adapter, "runtime-config")) {
        ;(adapter as AgentHarnessAdapter & RuntimeConfigurableAdapter).setAuth(
          acp(next.harness)
            ? acpEnv(next.harness, next.auth)
            : runtimeAuthForAdapter(nextAuth),
        )
      }

      if (!replacing) runner = next.harness
      if (adapter?.applyConfig) {
        await adapter.applyConfig({
          mcp: next.mcp,
          auth: next.auth,
          harness: next.harness,
          model: next.model,
        })
      }
      await Promise.all([...sessionAdapters.entries()].map(([key, nextAdapter]) => {
        return activeTurns.get(nextAdapter)?.size
          ? Promise.resolve()
          : configureAdapter(nextAdapter, sessionAdapterRunners.get(key) ?? runnerFromAdapterKey(key), next.model)
      }))
      await applyAgentExtensionsSnapshot(next.agent_extensions, directory)
      state = "ready"
      err = ""
      const updatedAt = new Date().toISOString()
      configApply = {
        state: "applied",
        revision,
        ...(acceptedAt ? { acceptedAt } : {}),
        updatedAt,
        harness: next.harness,
      }
      await persistRuntimeConfigApplyStatus({ directory, status: configApply })
    } catch (cause) {
      const updatedAt = new Date().toISOString()
      configApply = {
        state: "failed",
        revision,
        ...(acceptedAt ? { acceptedAt } : {}),
        updatedAt,
        harness: next.harness,
        error: runtimeConfigApplyError(cause),
      }
      await persistRuntimeConfigApplyStatus({ directory, status: configApply }).catch(() => {})
      if (cause instanceof RuntimeConfigApplyError) {
        state = cause.status === 500 ? "error" : "ready"
        err = cause.status === 500 ? cause.message : ""
        throw cause
      }
      state = "error"
      err = errorMessage(cause)
      throw cause
    }
  }

  return {
    mount(app: Hono, options: WorkspaceHostMountOptions) {
      assertWorkspaceRuntimeExposure({ exposure: options.exposure, env: process.env })
      if (options.core) {
        mountWorkspaceCore(app, options.core.upgradeWebSocket, { eventHub, exposure: options.exposure })
      } else {
        if (options.pty) mountWorkspacePty(app, options.pty.upgradeWebSocket)
        if (options.process) mountWorkspaceProcess(app)
        if (options.agentHooks) mountWorkspaceAgentHooks(app)
      }
      app.get("/api/wr/harness-config-options", async (c) => {
        const requestedHarness = normalizeHarnessIdentity(c.req.query("harness") || c.req.query("runner") || c.req.query("type"))
        const targetRunner = requestedHarness
          ? {
              id: requestedHarness.id,
              access: requestedHarness.access,
              ...(c.req.query("binary") ? { connection: { kind: "process" as const, binary: c.req.query("binary")! } } : {}),
            }
          : runner
        if (targetRunner.id === "opencode") {
          return c.json({
            ok: false,
            error: {
              code: "harness_config_options_unavailable",
              harness: targetRunner.id,
              message: "opencode model options are exposed through /provider, not harness config options",
            },
          }, 404)
        }
        if (
          (targetRunner.access === "native" && isStaticSdkHarness(targetRunner.id))
          || (targetRunner.id === "codex" && targetRunner.access === "acp")
        ) {
          return c.json([sdkModelConfigOption(targetRunner.id)])
        }
        const adapter = await ensureSessionAdapter(targetRunner)
        const directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
        try {
          if (!adapter.probeConfigOptions) {
            return c.json({
              ok: false,
              error: {
                code: "harness_config_options_unavailable",
                harness: targetRunner.id,
                message: `${targetRunner.id} does not expose harness config options`,
              },
            }, 404)
          }
          return c.json(await adapter.probeConfigOptions(directory))
        } catch (cause) {
          return c.json({
            ok: false,
            error: {
              code: "harness_config_options_unavailable",
              harness: targetRunner.id,
              message: harnessConfigOptionsErrorMessage({
                harness: targetRunner,
                cause,
              }),
            },
          }, 502)
        }
      })

      app.get("/session/status", async (c) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true) {
          const directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
          return c.json(sessionStatusSnapshot(await adapter.listSessions(directory)))
        }
        return (await proxyOpenCode(c, adapter, hostOptions.opencodeHeaders))!
      })

      app.get("/mcp", async (c) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true) return c.json({})
        return proxyOpenCodeOrJson(c, adapter, () => mcpStatus(currentMcp), hostOptions.opencodeHeaders)
      })

      app.post("/mcp/:name/connect", async (c) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true) return c.json(true)
        return (await proxyOpenCode(c, adapter, hostOptions.opencodeHeaders))!
      })

      app.post("/mcp/:name/disconnect", async (c) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true) return c.json(true)
        return (await proxyOpenCode(c, adapter, hostOptions.opencodeHeaders))!
      })

      app.get("/lsp", async (c) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true) return c.json([])
        return proxyOpenCodeOrJson(c, adapter, () => [], hostOptions.opencodeHeaders)
      })

      // Cloud control plane proxies /provider through here so the session
      // sidebar can list model metadata for both OpenCode and ACP runners.
      app.get("/provider", async (c) => {
        const requestedHarness = c.req.query("harness") || c.req.query("runner")
        if (runner.id !== "opencode" && requestedHarness !== "opencode") return c.json(providerUnavailable(runner), 502)
        if (hostOptions.opencodeCompat !== true) {
          return c.json({
            ok: false,
            error: {
              code: "provider_models_unavailable",
              harness: "opencode",
              message: "opencode provider metadata is unavailable because compatibility proxying is disabled",
            },
          }, 502)
        }
        const adapter = runner.id === "opencode" ? ensure() : await ensureSessionAdapter({ id: "opencode", access: "native" })
        try {
          const res = await proxyOpenCode(c, adapter, hostOptions.opencodeHeaders)
          if (res?.ok) {
            const body = await res.json().catch(() => undefined) as
              | { all?: unknown[]; connected?: unknown[]; default?: Record<string, unknown> }
              | undefined
            if (providerListHasModels(body)) return c.json(body)
          }
          return c.json({
            ok: false,
            error: {
              code: "provider_models_unavailable",
              harness: "opencode",
              message: "opencode provider metadata did not include live model data",
            },
          }, 502)
        } catch (cause) {
          return c.json({
            ok: false,
            error: {
              code: "provider_models_unavailable",
              harness: "opencode",
              message: errorMessage(cause),
            },
          }, 502)
        }
      })

      app.get("/experimental/tool/ids", async (c) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true || !hasAdapterCapability(adapter, "http-proxy")) {
          return c.json({
            ok: false,
            error: {
              code: "tool_catalog_unavailable",
              harness: runner.id,
              message: `${runner.id} does not expose a live Tool catalog`,
            },
          }, 502)
        }
        return (await proxyOpenCode(c, adapter, hostOptions.opencodeHeaders))!
      })

      app.get("/vcs", async (c) => {
        const adapter = ensure()
        const fallback = () => localVcsInfo(requestDirectory(c))
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true) return c.json(await fallback())
        return proxyOpenCodeOrJson(c, adapter, fallback, hostOptions.opencodeHeaders)
      })

      app.get("/global/event", async (c) => {
        const adapter = runner.id === "opencode" && hostOptions.opencodeCompat === true ? ensure() : undefined
        if (adapter && hasAdapterCapability(adapter, "http-proxy")) {
          try {
            const request = await (adapter as AgentHarnessAdapter & HttpProxyAdapter).getRequestFn()
            const headers = new Headers(hostOptions.opencodeHeaders)
            headers.set("Accept", "text/event-stream")
            const res = await request(new Request(`${OPENCODE_INTERNAL_BASE}/global/event`, {
              headers,
              signal: c.req.raw.signal,
            }))
            if (!res.ok || !res.body) return closedSse()
            return new Response(res.body, { status: res.status, headers: res.headers })
          } catch {
            return closedSse()
          }
        }

        let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
        const body = new ReadableStream<Uint8Array>({
          start(next) {
            ctrl = next
            next.enqueue(encodeSseData({ payload: { id: "server.connected", type: "server.connected", properties: {} } }))
          },
        })

        const cleanup = attachSseFanout({
          subscribe: eventHub.subscribeGlobal,
          write: (event, meta) => ctrl?.enqueue(encodeSseData(event, meta?.id)),
          heartbeat: { payload: { type: "server.heartbeat", properties: {} } },
          heartbeatMs: 10_000,
          lastEventId: c.req.header("last-event-id"),
          replay: globalEventReplay,
          replayLive: false,
        })

        c.req.raw.signal.addEventListener("abort", () => {
          cleanup()
          try {
            ctrl?.close()
          } catch {}
        })

        return new Response(body, { headers: sseHeaders() })
      })

      // Session V2 is the durable agent-control contract used by hosted
      // WorkGraph. Keep it on the authenticated workspace-runtime/relay path
      // and proxy byte-for-byte to the local OpenCode engine.
      const proxySessionV2 = async (c: Context) => {
        const adapter = ensure()
        if (runner.id !== "opencode" || hostOptions.opencodeCompat !== true || !hasAdapterCapability(adapter, "http-proxy")) {
          return c.json({ error: { code: "session_v2_unavailable", message: "Session V2 requires the OpenCode HTTP runtime" } }, 503)
        }
        return (await proxyOpenCode(c, adapter, hostOptions.opencodeHeaders))!
      }
      app.all("/api/session", proxySessionV2)
      app.all("/api/session/*", proxySessionV2)

      app.route("/", SessionRoutes((input) => adapterForSession(input), {
        eventHub,
        resolveRuntime: (input) => runtimeForSession(input),
        listSessions: (c, directory) => listSessions(c as { req: { query: (k: string) => string | undefined } }, directory),
        listPermissions: (c, directory) => listPermissions(c as { req: { query: (k: string) => string | undefined } }, directory),
        listQuestions: (c, directory) => listQuestions(c as { req: { query: (k: string) => string | undefined } }, directory),
        createActiveTurnScope: (input) => createActiveTurnScope(input),
        getMessages: async ({ sessionId }) => {
          if (!store().getSession(sessionId)) return undefined
          const messages = store().getMessages(sessionId)
          return messages
        },
        getMessageSnapshot: async ({ sessionId }) => {
          if (!store().getSession(sessionId)) return undefined
          return {
            messages: store().getMessages(sessionId),
            maxEventOrdinal: store().getSessionMaxSeq(sessionId),
          }
        },
        getSession: async ({ adapter, directory, sessionId }) => {
          return store().getSession(sessionId) ?? await adapter.getSession(sessionId, directory)
        },
        getTodos: async ({ sessionId }) => {
          if (!store().getSession(sessionId)) return undefined
          return store().getTodos(sessionId)
        },
        getSessionConfig: async ({ adapter, directory, sessionId }) => {
          const config = store().getSessionConfig(sessionId) ?? await adapter.getSessionConfig(sessionId, directory)
          if (config.model && config.agent && config.variant !== undefined) return config
          const session = store().getSession(sessionId)
          const recovered = mergeRecoveredSessionConfig(
            config,
            sessionRowConfigPatch(session ?? await adapter.getSession(sessionId, directory)),
          )
          return recovered
        },
        updateSessionConfig: async ({ adapter, directory, sessionId, update }) => {
          store().updateSessionConfig(sessionId, update, { directory })
          const adapterConfig = await adapter.updateSessionConfig(sessionId, update, directory)
          return store().updateSessionConfig(sessionId, adapterConfig, { directory }) ?? adapterConfig
        },
        ...(hostOptions.opencodeHeaders ? { opencodeHeaders: hostOptions.opencodeHeaders } : {}),
      }))
      app.route("/", OpenCodeCompatRoutes())
    },
    async apply(next: RuntimeSnapshot) {
      const normalized = normalizeRuntimeSnapshot(next)
      if (!normalized) throw new RuntimeConfigApplyError("runtime_config_invalid", "Invalid runtime config snapshot", 409)
      const nextAuth = runtimeAuth(normalized.auth)
      if (
        adapter
        && adapterKey(normalized.harness) === adapterKey(runner)
        && acp(runner)
        && hasAdapterCapability(adapter, "runtime-config")
        && (activeTurns.get(adapter)?.size ?? 0) > 0
        && (
          normalized.model !== undefined
          || !sameRuntimeAuth(currentAuth, nextAuth)
          || !sameRuntimeMcp(currentMcp, normalized.mcp)
        )
      ) {
        throw new RuntimeConfigApplyError(
          "runtime_config_unsafe_restart",
          "ACP runtime config change would restart an active session",
          409,
          {
            harness: runner.id,
            activeTurns: activeTurns.get(adapter)?.size ?? 0,
          },
        )
      }
      const pending = applyQueue.then(() => applySnapshot(normalized), () => applySnapshot(normalized))
      applyQueue = pending.catch(() => {})
      return pending
    },
    detail() {
      const health = runnerHealth()
      return {
        state,
        healthStatus: healthStatus(health),
        harness: runner,
        error: err,
        harnessHealth: health,
        workspaceHarnessEnabled: enabled,
        configApply,
      }
    },
    capabilities() {
      return workspaceCapabilities(enabled)
    },
    async registerSessionTools(input) {
      const directory = options.target?.directory ?? workspaceDir()
      const next = await adapterForSession({ sessionId: input.sessionId, directory })
      if (!hasAdapterCapability(next, "http-proxy")) throw new Error("Session harness does not support Core V2 tools")
      const response = await next.getRequestFn().then((request) => request(new Request(
        `${OPENCODE_INTERNAL_BASE}/api/session/${encodeURIComponent(input.sessionId)}/tool`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": directory },
          body: JSON.stringify({ callbackUrl: input.callbackUrl, tools: input.tools }),
          // @ts-ignore Node fetch requires duplex for request bodies.
          duplex: "half",
        },
      )))
      if (!response.ok) throw new Error(`Core Session tool registration failed: ${response.status} ${await response.text()}`)
    },
    async unregisterSessionTools(sessionId) {
      const directory = options.target?.directory ?? workspaceDir()
      const next = await adapterForSession({ sessionId, directory })
      if (!hasAdapterCapability(next, "http-proxy")) return
      const response = await next.getRequestFn().then((request) => request(new Request(
        `${OPENCODE_INTERNAL_BASE}/api/session/${encodeURIComponent(sessionId)}/tool`,
        { method: "DELETE", headers: { "x-opencode-directory": directory } },
      )))
      if (!response.ok && response.status !== 404) {
        throw new Error(`Core Session tool cleanup failed: ${response.status} ${await response.text()}`)
      }
    },
    dispose() {
      cleanupGlobalEventReplay()
      clear()
      for (const next of sessionAdapters.values()) {
        next.dispose()
        activeTurns.delete(next)
      }
      sessionAdapters.clear()
      sessionRuntimes.clear()
      sessionConfigStore?.close?.()
      sessionConfigStore = undefined
    },
  }
}

function isStaticSdkHarness(id: AgentHarnessId): id is "claude" | "codex" | "cursor" {
  return id === "claude" || id === "codex" || id === "cursor"
}
