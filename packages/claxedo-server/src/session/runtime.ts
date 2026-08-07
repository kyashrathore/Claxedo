import { randomUUID } from "node:crypto"
import {
  createAgentRuntime,
  createSubagentAdmissionBoundary,
  type AgentHarnessFactory,
  type AgentMessageRow,
  type AgentRuntimeStore,
  type AgentSessionRow,
  type SandboxRef,
  type SessionConfigUpdate,
  type SessionEnvFactory,
  type SubagentAdmissionStore,
  type SubagentObservation,
} from "@claxedo/agent-sdk-runtime"
import {
  codexBundlePiBackendResolver,
  firstPiModelBackend,
  localPiModelBackendResolver,
  piApiKeyBackendResolver,
  PiHarnessAdapter,
  type AgentRuntimeStoreWithRecovery,
  type PiAgentTool,
  type PiModelBackendResolver,
} from "@claxedo/agent-sdk-runtime/adapters"
import { Type } from "@sinclair/typebox"
import { putCredential, resolveSecret } from "../credentials/registry"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { createRuntimeEventHub } from "@claxedo/agent-sdk-runtime/runtime-event-hub"
import { eventSessionId } from "@claxedo/agent-sdk-runtime/compat-events"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import {
  createWakes,
  createScheduler,
  handleWakeToolCall,
  getWakeToolDefinitions,
  type Wakes,
  type WakeResult,
} from "@claxedo/wakes"
import { SqliteWakeStore } from "@claxedo/wakes/sqlite"
import { createSessionRoutes, runtimeEventsHandler, type RuntimeSessionBusEvent } from "@claxedo/workspace-runtime/routes"
import type { ControlPlaneServices } from "../authority/services"
import type { SessionMeta } from "../session/meta"
import { createConnectionTurnCredentials, type ConnectionTurnCredentials } from "../connections/turn-credentials"
import { piRegistryCredentialProvider } from "../credentials/pi-credentials"
import { piProviderCatalog, validatePiPromptModel } from "../credentials/pi-provider-catalog"
import {
  emitLlmTurnCompleted,
  emitSessionStarted,
  llmTurnRecord,
  workGraphSessionAttribution,
  type UsageLedger,
} from "../platform/telemetry/product/metering"
import type { ProductDeploymentMode, ProductIdentity } from "../platform/telemetry/product/product"

type SourceChannel = "github" | "slack" | "telegram" | "discord" | "whatsapp"

type SessionBus = {
  publish: (event: RuntimeSessionBusEvent) => void
  subscribe: (fn: (event: unknown) => void) => () => void
}

function createSessionBus(): SessionBus {
  const subscribers = new Set<(event: unknown) => void>()
  return {
    publish(event) {
      for (const subscriber of subscribers) subscriber(event)
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
  }
}

function sessionConfigError(status: 400 | 409, code: string, message: string) {
  return new HTTPException(status, {
    res: Response.json({ error: { code, message } }, { status }),
  })
}

function virtualToolSandbox(input: SandboxRef | undefined): SandboxRef {
  return input ?? { kind: "virtual", id: "central-pi" }
}

// Placement must survive restarts: the tools-only sandbox ref is persisted as a
// first-class `tool_sandbox` field on session meta (not tags), so recovery
// reproduces the exact sandbox — including the case where the tool sandbox's
// workspace differs from the session's own `workspaceID`. Tags stay purely
// free-form labels and can be rewritten by other writers without clobbering
// placement.
function toolSandboxFromMeta(meta: SessionMeta): SandboxRef {
  const stored = meta.toolSandbox
  if (stored?.kind === "workspace-runtime") {
    return {
      kind: "workspace-runtime",
      workspaceId: stored.workspaceId,
      ...(stored.directory ? { directory: stored.directory } : {}),
      ...(stored.worktree ? { worktree: stored.worktree } : {}),
      ...(stored.baseCommit ? { baseCommit: stored.baseCommit } : {}),
      ...(stored.leaseEpoch !== undefined ? { leaseEpoch: stored.leaseEpoch } : {}),
    }
  }
  return { kind: "virtual", id: "central-pi" }
}

function metaRow(meta: SessionMeta): AgentSessionRow {
  return {
    id: meta.sessionID,
    title: meta.title ?? null,
    slug: meta.sessionID,
    version: "central",
    ...(meta.parentID ? { parentID: meta.parentID } : {}),
    ...(meta.rootID ? { rootID: meta.rootID } : {}),
    ...(meta.projectID ? { projectID: meta.projectID } : {}),
    ...(meta.tags.length > 0 ? { tags: meta.tags } : {}),
    ...(meta.attachments.length > 0 ? { attachments: meta.attachments } : {}),
    time: {
      created: meta.createdAt,
      updated: meta.updatedAt,
      ...(meta.archived ? { archived: meta.archived } : {}),
    },
  }
}

function messageRow(input: unknown): input is AgentMessageRow {
  if (!input || typeof input !== "object") return false
  const item = input as { info?: unknown; parts?: unknown }
  if (!item.info || typeof item.info !== "object") return false
  const info = item.info as { id?: unknown; role?: unknown }
  return typeof info.id === "string" && typeof info.role === "string" && Array.isArray(item.parts)
}

type CentralSessionRuntimeOptions = {
  createEnv?: SessionEnvFactory
  turnCredentials?: ConnectionTurnCredentials
  admitWorkspaceSession?: (input: {
    sessionId: string
    workspaceId: string
    baseCommit?: string
  }) => Promise<{ directory: string; worktree: string; baseCommit: string; leaseEpoch: number }>
  /**
   * The authoritative destination for completed-turn token
   * counts, dual-written beside the best-effort PostHog capture. Absent = the
   * analytics event still goes out and nothing is recorded, which is the
   * correct posture for a self-host box with no control plane.
   */
  usageLedger?: UsageLedger
  /** Product-plane `deployment_mode` for turn metering; defaults to self-host. */
  productDeploymentMode?: ProductDeploymentMode
  /** Deterministic model backend injection for tests and embedded deployments. */
  modelBackend?: PiModelBackendResolver
  /** Hard ceiling for background subagents; production defaults to 15 minutes. */
  subagentTimeoutMs?: number
}

/**
 * Registry-backed codex backend: the bundle arrives via the consent-gated
 * credential sync flow (`claxedo creds sync` → PUT /credentials), so a
 * DEPLOYED box needs no home-dir credential files. Rotated refresh tokens are
 * persisted back onto the same registry credential.
 */
function registryCodexBackend(modelId?: string): PiModelBackendResolver {
  const providerFor = () => piRegistryCredentialProvider("openai-codex")
  return codexBundlePiBackendResolver({
    loadBundle: async () => {
      const provider = providerFor()
      return provider ? await resolveSecret(provider) ?? undefined : undefined
    },
    persist: async (credentials) => {
      const provider = providerFor()
      if (!provider) return
      const existing = await resolveSecret(provider)
      let bundle: Record<string, unknown> = {}
      try {
        bundle = existing ? JSON.parse(existing) as Record<string, unknown> : {}
      } catch {}
      const tokens = bundle.tokens && typeof bundle.tokens === "object" ? bundle.tokens as Record<string, unknown> : {}
      await putCredential({
        provider_id: provider,
        kind: "oauth_token",
        source: "managed",
        label: "Rotated by central pi model backend",
        secret: JSON.stringify({
          ...bundle,
          type: "codex_auth",
          access: credentials.access,
          refresh: credentials.refresh,
          expires: credentials.expires,
          tokens: {
            ...tokens,
            access_token: credentials.access,
            refresh_token: credentials.refresh,
            ...(typeof credentials.accountId === "string" ? { account_id: credentials.accountId } : {}),
          },
          oauth: {
            access: credentials.access,
            refresh: credentials.refresh,
            expires: credentials.expires,
            ...(typeof credentials.accountId === "string" ? { account_id: credentials.accountId } : {}),
          },
          last_refresh: new Date().toISOString(),
        }),
        ...(typeof credentials.expires === "number" && credentials.expires > 0 ? { expires_at: credentials.expires } : {}),
      })
    },
    ...(modelId ? { modelId } : {}),
  })
}

/**
 * Opt-in model backend for central sessions. `CLAXEDO_PI_MODEL` selects an
 * explicit `provider/modelId` (or `auto` for credential-based auto-selection);
 * `CLAXEDO_PI_MODEL_BACKEND=1` is the bare auto-select switch. Absent both,
 * central sessions stay tools-only and no credential store is read.
 *
 * Resolution order per turn: the credential REGISTRY (deployed-box path,
 * populated by consented sync) first, then local home-dir auth stores (dev).
 */
export function centralModelBackend(): { modelBackend: PiModelBackendResolver } {
  const model = process.env.CLAXEDO_PI_MODEL?.trim()
  const enabled = (model && model.length > 0) || process.env.CLAXEDO_PI_MODEL_BACKEND === "1"
  const override = model && model !== "auto" ? model : undefined
  const codexModelId = override?.startsWith("openai-codex/") ? override.slice("openai-codex/".length) : undefined
  return {
    modelBackend: firstPiModelBackend(
      async (input) => !input.model || input.model.providerID === "openai-codex"
        ? registryCodexBackend(codexModelId)(input)
        : undefined,
      piApiKeyBackendResolver({
        loadApiKey: async ({ providerID }) => {
          if (providerID !== "anthropic" && providerID !== "openai") return undefined
          const credentialProvider = piRegistryCredentialProvider(providerID)
          return credentialProvider ? await resolveSecret(credentialProvider) ?? undefined : undefined
        },
      }),
      ...(enabled ? [localPiModelBackendResolver({
        ...(override ? { modelOverride: override } : {}),
      })] : []),
    ),
  }
}

// --- Wakes (out-of-band session resumption) --------------------------------
// Opt-in via CLAXEDO_WAKES=1. The wake tool logic lives in @claxedo/wakes; here
// we only render a fired wake into an injected message and expose the four
// session-scoped agent tools.

const WAKE_TOOL_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  getWakeToolDefinitions().map((d) => [d.name, d.description]),
)

function renderWakeResult(r: WakeResult): string {
  if (r.trigger === "on_approval") return `[wake] approval from ${r.resolvedBy.userId}: ${r.answer}`
  if (r.trigger === "on_event")
    return `[wake] event fired — payload ${JSON.stringify(r.payload)} (intent ${JSON.stringify(r.intent)})`
  if ("expired" in r && r.expired) return `[wake] gave up waiting (intent ${JSON.stringify(r.intent)})`
  return `[wake] scheduled follow-up fired (intent ${JSON.stringify(r.intent)})`
}

function buildWakeTools(wakes: Wakes, sessionId: string, workspaceId: string): PiAgentTool[] {
  const mk = (name: string, parameters: unknown): PiAgentTool =>
    ({
      name,
      label: name,
      description: WAKE_TOOL_DESCRIPTIONS[name] ?? name,
      parameters,
      execute: async (_toolCallId: string, params: unknown) => {
        try {
          const r = await handleWakeToolCall(name, (params ?? {}) as Record<string, unknown>, {
            wakes,
            sessionId,
            workspaceId,
            now: Date.now,
          })
          return { content: [{ type: "text", text: r.text }], details: r }
        } catch (e) {
          return {
            content: [{ type: "text", text: `wake tool error: ${(e as Error).message}` }],
            details: { ok: false },
          }
        }
      },
    }) as unknown as PiAgentTool
  return [
    mk("schedule_followup", Type.Object({ when: Type.String(), intent: Type.Optional(Type.Unknown()) })),
    mk(
      "watch",
      Type.Object({
        event_key: Type.String(),
        intent: Type.Optional(Type.Unknown()),
        expires_in: Type.Optional(Type.String()),
      }),
    ),
    mk("request_approval", Type.Object({ prompt: Type.String(), expires_in: Type.Optional(Type.String()) })),
    mk("cancel_wake", Type.Object({ wake_id: Type.String() })),
  ]
}

export function createCentralSessionRuntime(services: ControlPlaneServices, options: CentralSessionRuntimeOptions = {}) {
  const eventHub = createRuntimeEventHub()
  const turnCredentials = options.turnCredentials ?? createConnectionTurnCredentials()
  const subagentChildren = new Set<string>()
  const sessionPlacements = new Map<string, { workspaceId?: string; toolSandbox: SandboxRef }>()
  // Late-bound because the subagent tool needs createHybridSession + the message
  // routes, which are built after the adapter. The factory captures the source
  // session so child sessions inherit its concrete model.
  let dispatchToolsForSession = (_sessionId: string): PiAgentTool[] => []
  // Assigned below (needs placementRoutes + createHybridSession); captured here
  // so each turn gets session-scoped wake tools. Opt-in via CLAXEDO_WAKES=1.
  let wakes: Wakes | undefined
  const baseModelBackend = options.modelBackend ?? centralModelBackend().modelBackend
  const modelBackend: PiModelBackendResolver = async (input) => {
    const backend = await baseModelBackend(input)
    if (!backend) return undefined
    const meta = await services.projectionStore.session_meta(input.sessionId)
    const extraTools = [
      ...(backend.extraTools ?? []),
      ...(subagentChildren.has(input.sessionId) || meta?.parentID ? [] : dispatchToolsForSession(input.sessionId)),
    ]
    if (wakes) {
      const workspaceId = (meta?.workspaceID as string | undefined) ?? input.sessionId
      extraTools.push(...buildWakeTools(wakes, input.sessionId, workspaceId))
    }
    return { ...backend, extraTools }
  }
  const adapter = new PiHarnessAdapter({
    eventHub,
    defaultPlacement: {
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "virtual", id: "central-pi" },
    },
    // Real pi model turns (Demo A): resolved lazily per turn from the local
    // auth stores (pi's own store, the Codex CLI bundle, env keys). EXPLICIT
    // OPT-IN ONLY — reading local credential stores must never be a silent
    // default (consent model), and tests stay hermetic. Enable with
    // CLAXEDO_PI_MODEL=provider/modelId (or "auto"), or CLAXEDO_PI_MODEL_BACKEND=1.
    modelBackend,
    toolExtensionProvider: { providesSubagentTool: () => true },
    ...(options.createEnv ? { createEnv: options.createEnv } : {}),
  })
  const runtimeStore = createMemoryRuntimeStore() as unknown as AgentRuntimeStoreWithRecovery
  const subagentStore = runtimeStore as AgentRuntimeStoreWithRecovery & SubagentAdmissionStore & {
    listSubagents(parentSessionId: string): unknown[]
  }
  const subagentAdmission = createSubagentAdmissionBoundary({
    store: {
      admit: (input) => subagentStore.admit(input),
      markPublished: (parentSessionId, observationId) => subagentStore.markPublished(parentSessionId, observationId),
    },
    publish: (parentSessionId, event) => eventHub.publishRuntime({
      directory: parentSessionId,
      sessionId: parentSessionId,
      payload: event,
    }),
  })
  const runtime = createAgentRuntime({
    store: runtimeStore as unknown as AgentRuntimeStore,
    harnesses: [{
      id: "pi",
      access: "native",
      create: () => adapter,
    } as unknown as AgentHarnessFactory],
  })
  const sessionBus = createSessionBus()
  const runTurn = <T>(input: { sessionId: string; subject?: string; orgId?: string }, fn: () => T) => {
    const credential = turnCredentials.mint(input)
    return turnCredentials.run(credential, fn)
  }
  // Turn metering (metric spec §4.3, §4.5).
  //
  // The turn credential is the only identity that reaches this far in: the
  // signed request is several layers above, and by the time a message
  // completes there is no `Context` left to read. `runTurn` puts the verified
  // subject and org into an async-local scope that spans the whole turn, so
  // resolving it here attributes the completion to the caller that authorized
  // it — without threading auth through the event hub.
  //
  // Both halves are required: a subject without an org cannot key a per-org
  // aggregate, and substituting a placeholder org would corrupt every one of
  // them. Personal-account turns therefore fall through to the ops plane.
  const turnIdentity = (): ProductIdentity | undefined => {
    const turn = turnCredentials.resolve(turnCredentials.current())
    if (!turn?.subject || !turn.orgId) return undefined
    return {
      org_id: turn.orgId,
      user_id: turn.subject,
      surface: "session",
      deployment_mode: options.productDeploymentMode ?? "self-host",
    }
  }
  const sessionHarness = (sessionId: string) =>
    runtimeStore.getSessionConfig(sessionId)?.harness?.id ?? "pi"
  const meterCompletedTurn = (event: CompatEnvelope) => {
    if (event.payload.type !== "message.updated") return
    const info = (event.payload.properties as { info?: unknown }).info
    const sessionId = eventSessionId(event.payload)
    // Resolved synchronously: the async-local turn scope unwinds as soon as
    // this returns, so reading it after an await would find nothing.
    const identity = turnIdentity()
    const localAttribution = workGraphSessionAttribution(sessionId ?? "")
    void (async () => {
      const hostedAttribution = !localAttribution && identity && sessionId
        ? await options.usageLedger?.resolveWorkGraphAttribution?.({
          org_id: identity.org_id,
          user_id: identity.user_id,
          session_id: sessionId,
        })
        : undefined
      const record = llmTurnRecord({
        message: info,
        harness: sessionHarness(sessionId ?? ""),
        attribution: localAttribution ?? (hostedAttribution ? {
          streamId: hostedAttribution.stream_id,
          runId: hostedAttribution.run_id,
          workItemId: hostedAttribution.work_item_id,
        } : undefined),
      })
      if (!record) return
      await emitLlmTurnCompleted({
        identity,
        sink: services.telemetry,
        ledger: options.usageLedger,
        record,
      })
    })()
  }
  async function deploymentDefaultModel(sessionId: string) {
    const configured = process.env.CLAXEDO_PI_MODEL?.trim()
    const enabled = !!configured || process.env.CLAXEDO_PI_MODEL_BACKEND === "1"
    if (!enabled) return
    const explicit = configured && configured !== "auto"
      ? (() => {
          const slash = configured.indexOf("/")
          if (slash <= 0 || slash === configured.length - 1) {
            throw new Error("CLAXEDO_PI_MODEL must use provider/model syntax or be 'auto'")
          }
          return { providerID: configured.slice(0, slash), modelID: configured.slice(slash + 1) }
        })()
      : undefined
    const catalog = piProviderCatalog()
    const candidates = explicit
      ? [explicit]
      : catalog.connected.flatMap((providerID) => {
          const modelID = catalog.default[providerID]
          return modelID ? [{ providerID, modelID }] : []
        })
    for (const model of candidates) {
      const backend = await baseModelBackend({ sessionId, model })
      if (backend) return { providerID: backend.model.provider, modelID: backend.model.id }
    }
  }
  function bindRuntimeSession(input: {
    id: string
    title?: string | null
    model?: { providerID: string; modelID: string }
    parentSessionId?: string
  }) {
    const currentModel = runtimeStore.getSessionConfig(input.id)?.model
    runtimeStore.bindSession({
      sessionId: input.id,
      directory: input.id,
      title: input.title ?? undefined,
      agentSessionId: input.id,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    })
    runtimeStore.updateSessionConfig(input.id, {
      harness: { id: "pi", access: "native" },
      model: input.model ?? currentModel ?? { providerID: "pi", modelID: "virtual" },
      variant: null,
      agent: null,
    })
  }
  async function ensureCentralRuntimeSession(sessionId: string) {
    if (runtimeStore.getSession(sessionId)) return true
    const meta = await services.projectionStore.session_meta(sessionId)
    if (meta?.host !== "central") return false
    if (meta.parentID) subagentChildren.add(sessionId)
    sessionPlacements.set(sessionId, {
      ...(meta.workspaceID ? { workspaceId: meta.workspaceID } : {}),
      toolSandbox: toolSandboxFromMeta(meta),
    })
    await adapter.bindSession({
      id: sessionId,
      ...(meta.parentID ? { parentID: meta.parentID } : {}),
      title: meta.title ?? null,
      placement: {
        mode: "hybrid",
        host: "central",
        ...(meta.workspaceID ? { workspaceId: meta.workspaceID } : {}),
        toolSandbox: toolSandboxFromMeta(meta),
      },
    })
    if (meta.model) await adapter.updateSessionConfig(sessionId, { model: meta.model }, undefined)
    bindRuntimeSession({
      id: sessionId,
      title: meta.title ?? null,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.parentID ? { parentSessionId: meta.parentID } : {}),
    })
    return true
  }
  const routes = createSessionRoutes({
    resolveAdapter: () => adapter,
    beforeSessionOperation: async (_c, input) => {
      if (input.operation === "delete_session") await terminateBackgrounds(input.sessionId, "interrupted")
    },
    resolveRuntime: async (_c, input) => {
      if (input?.sessionId) await ensureCentralRuntimeSession(input.sessionId)
      return runtime
    },
    resolveDirectory: () => undefined,
    listSessions: async () =>
      (await services.projectionStore.list_session_metas({ includeArchived: false }))
        .filter((meta) => meta.host === "central")
        .map(metaRow),
    getSession: async (_c, _directory, sessionId) => {
      const session = await adapter.getSession(sessionId, undefined)
      if (session) return session
      const meta = await services.projectionStore.session_meta(sessionId)
      if (meta?.host !== "central") return null
      await ensureCentralRuntimeSession(sessionId)
      return metaRow(meta)
    },
    getMessages: async (_c, _directory, sessionId) => {
      const messages: unknown[] = services.projectionStore.read_session_messages(sessionId)
      return messages.filter(messageRow)
    },
    getMessageSnapshot: async (_c, _directory, sessionId) => {
      const messages: unknown[] = services.projectionStore.read_session_messages(sessionId)
      return {
        messages: messages.filter(messageRow),
        maxEventOrdinal: services.projectionStore.read_session_max_event_ordinal(sessionId),
      }
    },
    getSessionConfig: async (_c, directory, sessionId) => {
      const meta = await services.projectionStore.session_meta(sessionId)
      const config = await adapter.getSessionConfig(sessionId, directory)
      return meta?.model ? { ...config, model: meta.model } : config
    },
    updateSessionConfig: async (_c, directory, sessionId, update: SessionConfigUpdate) => {
      const meta = await services.projectionStore.session_meta(sessionId)
      if (meta?.host !== "central") throw new Error(`No central session ${sessionId}`)
      if (update.model !== undefined) {
        if (!update.model) throw sessionConfigError(400, "pi_model_required", "Pi sessions require a provider and model")
        const invalid = update.model.providerID === "pi" && update.model.modelID === "virtual"
          ? undefined
          : validatePiPromptModel(update.model)
        if (invalid) throw sessionConfigError(400, invalid.code, invalid.message)
        const current = meta.model
        const changing = !current || current.providerID !== update.model.providerID || current.modelID !== update.model.modelID
        if (changing && services.projectionStore.read_session_messages(sessionId).length) {
          throw sessionConfigError(409, "pi_model_locked", "Start a new Pi session to use another model")
        }
        await services.projectionStore.put_session_meta(sessionId, { model: update.model })
      }
      try {
        const config = await adapter.updateSessionConfig(sessionId, update, directory)
        runtimeStore.updateSessionConfig(sessionId, config)
        return config
      } catch (cause) {
        if (update.model !== undefined) {
          await services.projectionStore.put_session_meta(sessionId, { model: meta.model ?? null })
        }
        runtimeStore.deleteSession(sessionId)
        if (cause instanceof Error && cause.message.includes("Start a new Pi session")) {
          throw sessionConfigError(409, "pi_model_locked", cause.message)
        }
        throw cause
      }
    },
    afterCreateSession: async (_c, _directory, session) => {
      const row = session as { id?: unknown; title?: unknown }
      if (typeof row.id !== "string") return
      bindRuntimeSession({
        id: row.id,
        title: typeof row.title === "string" ? row.title : null,
      })
      await services.projectionStore.put_session_meta(row.id, {
        host: "central",
        directory: null,
        title: typeof row.title === "string" ? row.title : null,
      })
    },
    afterUpdateSession: async (_c, _directory, session, updates) => {
      const row = session as { id?: unknown; title?: unknown; time?: { archived?: number } }
      if (typeof row.id !== "string") return
      if (updates.time?.archived !== undefined) await terminateBackgrounds(row.id, "interrupted")
      bindRuntimeSession({
        id: row.id,
        title: typeof row.title === "string" ? row.title : null,
      })
      await services.projectionStore.put_session_meta(row.id, {
        host: "central",
        directory: null,
        title: typeof row.title === "string" ? row.title : null,
        archived: updates.time?.archived ?? row.time?.archived ?? null,
      })
    },
    afterMessageCheckpoint: async (_c, directory, sessionId) => {
      const session = await adapter.getSession(sessionId, directory)
      if (!session || typeof session.title !== "string") return
      await services.projectionStore.put_session_meta(sessionId, {
        host: "central",
        directory: null,
        title: session.title,
      })
    },
    afterDeleteSession: async (_c, _directory, sessionId) => {
      runtimeStore.deleteSession(sessionId)
      await services.projectionStore.delete_session_meta(sessionId)
    },
    sessionBus,
    publishGlobal,
    resolveWorkspaceId: () => undefined,
  })

  /**
   * The single ingress every compat event crosses on its way out of a turn:
   * The live event hub, turn metering, session-title persistence, and the
   * durable message log. Named and returned on the runtime handle because it is
   * the one place that observes a completed turn — the signed request is
   * several layers above and there is no request context left by the time a
   * message completes.
   */
  function publishGlobal(event: CompatEnvelope) {
    eventHub.publishGlobal(event)
    meterCompletedTurn(event)
    const sessionId = eventSessionId(event.payload)
    if (event.payload.type === "session.updated") {
      const title = typeof event.payload.properties.info.title === "string"
        ? event.payload.properties.info.title
        : null
      void Promise.all([
        adapter.updateSession(event.payload.properties.info.id, { ...(title !== null ? { title } : {}) }, undefined),
        services.projectionStore.put_session_meta(event.payload.properties.info.id, {
          host: "central",
          directory: null,
          title,
        }),
      ]).catch((err: unknown) => {
        console.error("[central-runtime] failed to persist session title update:", err)
      })
    }
    if (sessionId) services.durableSessionLog.persist_message_event(sessionId, event.payload)
  }

  // Demo B — placement swap: attach/detach a session's tool sandbox
  // MID-CONVERSATION. PATCH /session/:id/placement with
  // { toolSandbox: { kind: "workspace-runtime", workspaceId, directory? } | { kind: "virtual" } }.
  // Refused while a turn is active (adapter idle guard). The new placement is
  // persisted on session meta so restarts recover it.
  const placementRoutes = new Hono()
  placementRoutes.patch("/session/:id/placement", async (c) => {
    const sessionId = c.req.param("id")
    const body = await c.req.json().catch(() => null) as { toolSandbox?: unknown } | null
    const raw = body?.toolSandbox
    let toolSandbox: SandboxRef
    if (!raw || typeof raw !== "object") {
      return c.json({ error: { code: "invalid_tool_sandbox", message: "toolSandbox object is required" } }, 400)
    }
    const ref = raw as { kind?: unknown; workspaceId?: unknown; directory?: unknown; id?: unknown }
    if (ref.kind === "workspace-runtime") {
      if (typeof ref.workspaceId !== "string" || !ref.workspaceId) {
        return c.json({ error: { code: "invalid_tool_sandbox", message: "workspace-runtime placement requires workspaceId" } }, 400)
      }
      toolSandbox = {
        kind: "workspace-runtime",
        workspaceId: ref.workspaceId,
        ...(typeof ref.directory === "string" && ref.directory ? { directory: ref.directory } : {}),
      }
    } else if (ref.kind === "virtual") {
      toolSandbox = { kind: "virtual", ...(typeof ref.id === "string" && ref.id ? { id: ref.id } : {}) }
    } else {
      return c.json({ error: { code: "invalid_tool_sandbox", message: "toolSandbox.kind must be workspace-runtime or virtual" } }, 400)
    }
    if (!(await ensureCentralRuntimeSession(sessionId)) && !(await adapter.getSession(sessionId, undefined))) {
      return c.json({ error: { code: "session_not_found", message: `No central session ${sessionId}` } }, 404)
    }
    const workspaceId = toolSandbox.kind === "workspace-runtime" ? toolSandbox.workspaceId : undefined
    try {
      await adapter.updateSessionPlacement(sessionId, {
        mode: "hybrid",
        host: "central",
        ...(workspaceId ? { workspaceId } : {}),
        toolSandbox,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const busy = message.includes("active turn")
      return c.json({ error: { code: busy ? "session_busy" : "placement_failed", message } }, busy ? 409 : 500)
    }
    await services.projectionStore.put_session_meta(sessionId, {
      host: "central",
      directory: null,
      ...(workspaceId ? { workspaceID: workspaceId } : {}),
      toolSandbox: toolSandbox.kind === "workspace-runtime"
        ? { kind: "workspace-runtime", workspaceId: toolSandbox.workspaceId, ...(toolSandbox.directory ? { directory: toolSandbox.directory } : {}) }
        : null,
    })
    sessionPlacements.set(sessionId, {
      ...(workspaceId ? { workspaceId } : {}),
      toolSandbox,
    })
    return c.json({ ok: true, placement: { sessionId, mode: "hybrid", host: "central", workspaceId: workspaceId ?? null, toolSandbox } })
  })
  // Cast: workspace-runtime pins hono 4.10 while this package is on 4.12 —
  // the app contract (fetch) is identical; only the nominal types diverge.
  placementRoutes.route("/", routes as never)

  async function createHybridSession(input: {
    sessionId?: string
    parentID?: string
    title?: string | null
    workspaceId?: string | null
    toolSandbox?: SandboxRef
    sourceChannel?: SourceChannel
    sourceThreadKey?: string
    subagentKey?: string
    spawningToolCallId?: string
    /** Harness id; only "pi" is dispatchable centrally today (route-validated). */
    harness?: string
    model?: { providerID: string; modelID: string }
    requireModel?: boolean
    admitToolSandbox?: boolean
  }) {
    if (input.model) {
      const invalid = validatePiPromptModel(input.model)
      if (invalid) throw new Error(invalid.message)
    }
    const sessionId = input.sessionId ?? randomUUID()
    const requestedToolSandbox = virtualToolSandbox(input.toolSandbox)
    const admitted = input.admitToolSandbox !== false && requestedToolSandbox.kind === "workspace-runtime" && options.admitWorkspaceSession
      ? await options.admitWorkspaceSession({
          sessionId,
          workspaceId: requestedToolSandbox.workspaceId,
          ...(requestedToolSandbox.baseCommit ? { baseCommit: requestedToolSandbox.baseCommit } : {}),
        })
      : undefined
    const toolSandbox = requestedToolSandbox.kind === "workspace-runtime" && admitted
      ? {
          ...requestedToolSandbox,
          directory: admitted.directory,
          worktree: admitted.worktree,
          baseCommit: admitted.baseCommit,
          leaseEpoch: admitted.leaseEpoch,
        }
      : requestedToolSandbox
    const workspaceId = input.workspaceId
      ?? (toolSandbox.kind === "workspace-runtime" ? toolSandbox.workspaceId : undefined)
    const existing = input.sessionId
      ? await services.projectionStore.session_meta(sessionId)
      : undefined
    if (existing) {
      const stored = toolSandboxFromMeta(existing)
      if (
        existing.host !== "central"
        || existing.workspaceID !== workspaceId
        || stored.kind !== toolSandbox.kind
        || (stored.kind === "workspace-runtime" && toolSandbox.kind === "workspace-runtime"
          && (stored.workspaceId !== toolSandbox.workspaceId || stored.directory !== toolSandbox.directory))
      ) throw new Error(`Session ${sessionId} already exists with different placement`)
      await ensureCentralRuntimeSession(sessionId)
      return { id: sessionId }
    }
    const session = await adapter.bindSession({
      id: sessionId,
      ...(input.parentID ? { parentID: input.parentID } : {}),
      title: input.title ?? null,
      placement: {
        mode: "hybrid",
        host: "central",
        ...(workspaceId ? { workspaceId } : {}),
        toolSandbox,
      },
    })
    sessionPlacements.set(session.id, {
      ...(workspaceId ? { workspaceId } : {}),
      toolSandbox,
    })
    const model = input.model ?? await deploymentDefaultModel(session.id)
    if (input.requireModel && !model) {
      await adapter.deleteSession(session.id, undefined)
      throw new Error("Pi model is not configured; select a model or configure CLAXEDO_PI_MODEL")
    }
    if (model) await adapter.updateSessionConfig(session.id, { model }, undefined)
    if (input.parentID) subagentChildren.add(session.id)
    bindRuntimeSession({
      id: session.id,
      title: input.title ?? "Hybrid Session",
      ...(model ? { model } : {}),
      ...(input.parentID ? { parentSessionId: input.parentID } : {}),
    })
    const tags = [
      ...(input.sourceChannel ? [`source-channel:${input.sourceChannel}`] : []),
      ...(input.sourceThreadKey ? [`source-thread:${input.sourceThreadKey}`] : []),
      ...(input.subagentKey ? [`subagent-key:${input.subagentKey}`] : []),
      ...(input.spawningToolCallId ? [`subagent-tool-call:${input.spawningToolCallId}`] : []),
      ...(input.harness && input.harness !== "pi" ? [`harness:${input.harness}`] : []),
    ]
    // Persist the tools-only sandbox verbatim as a first-class field. Only
    // workspace-runtime placements need recovery; virtual is the default and
    // stays implicit (null) so a restart with no stored ref falls back to the
    // in-memory virtual env.
    const storedToolSandbox = toolSandbox.kind === "workspace-runtime"
      ? {
          kind: "workspace-runtime" as const,
          workspaceId: toolSandbox.workspaceId,
          ...(toolSandbox.directory ? { directory: toolSandbox.directory } : {}),
          ...(toolSandbox.worktree ? { worktree: toolSandbox.worktree } : {}),
          ...(toolSandbox.baseCommit ? { baseCommit: toolSandbox.baseCommit } : {}),
          ...(toolSandbox.leaseEpoch !== undefined ? { leaseEpoch: toolSandbox.leaseEpoch } : {}),
        }
      : null
    await services.projectionStore.put_session_meta(session.id, {
      host: "central",
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(workspaceId ? { workspaceID: workspaceId } : {}),
      directory: null,
      ...(storedToolSandbox ? { toolSandbox: storedToolSandbox } : {}),
      title: input.title ?? "Hybrid Session",
      ...(model ? { model } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    })
    const boundSession = runtimeStore.getSession(session.id) as { time?: { updated?: unknown } } | null
    if (typeof boundSession?.time?.updated !== "number") {
      throw new Error(`Central session ${session.id} was persisted without an updated timestamp`)
    }
    eventHub.publishRuntime({
      directory: session.id,
      sessionId: session.id,
      payload: {
        type: "session-info",
        title: input.title ?? "Hybrid Session",
        ...(input.parentID ? { parentID: input.parentID } : {}),
        updatedAt: new Date(boundSession.time.updated).toISOString(),
      },
    })
    // Metric spec §4.5: server-emitted and attributable, replacing a
    // client-side funnel step that self-host suppresses. Emitted only on the
    // fresh-create branch — the `existing` path above returns early, so
    // reconnecting to a session never counts as starting one.
    emitSessionStarted({
      identity: turnIdentity(),
      sink: services.telemetry,
      session: {
        session_id: session.id,
        harness: input.harness ?? "pi",
        host: "central",
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      },
    })
    return session
  }

  // Wakes: durable out-of-band session resumption. Opt-in; a fired wake spawns a
  // fresh turn on its session by posting an injected message through the same
  // message route the in-process subagent tool uses. The scheduler drives time wakes;
  // deliverEvent/resolve are exposed on the return for the channels/webhook layer.
  if (process.env.CLAXEDO_WAKES === "1") {
    const store = new SqliteWakeStore({ path: process.env.CLAXEDO_WAKES_DB || ":memory:" })
    wakes = createWakes({
      store,
      // v1 authz: the 128-bit token is the guard for approvals; wire
      // services.authority for per-workspace resolver checks in a follow-up.
      authorize: () => true,
      spawnTurn: async (sessionId, result) => {
        const target = sessionId ?? (await createHybridSession({ title: "Scheduled Session", requireModel: true })).id
        await runTurn({ sessionId: target }, () =>
          placementRoutes.request(`http://127.0.0.1/session/${encodeURIComponent(target)}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text: renderWakeResult(result) }] }),
          }),
        )
      },
    })
    createScheduler(wakes, {
      onError: (e) => console.error("[central-runtime] wakes scheduler:", e),
    }).start()
  }

  type SubagentToolUpdate = Parameters<PiAgentTool["execute"]>[3]
  type ActiveBackground = {
    childSessionId: string
    terminate: (status: "killed" | "interrupted") => Promise<void>
  }
  const activeBackgrounds = new Map<string, Map<string, ActiveBackground>>()
  const backgroundCounts = new Map<string, number>()
  const subagentTimeoutMs = options.subagentTimeoutMs ?? 15 * 60 * 1_000

  function backgroundTasks(parentSessionId: string) {
    const current = activeBackgrounds.get(parentSessionId) ?? new Map<string, ActiveBackground>()
    activeBackgrounds.set(parentSessionId, current)
    return current
  }

  async function createDispatchedSession(sourceSessionId: string, input: {
    task: string
    title?: string
    background?: boolean
    toolCallId?: string
    signal?: AbortSignal
    onUpdate?: SubagentToolUpdate
  }) {
    const task = input.task.trim()
    if (!task) throw new Error("subagent task is required")
    const mode = input.background ? "background" as const : "foreground" as const
    const toolCallId = input.toolCallId ?? `pi-subagent-${randomUUID()}`
    const childSessionId = randomUUID()
    const source = await adapter.getSessionConfig(sourceSessionId, undefined)
    const sourceModel = source.model?.providerID === "pi" && source.model.modelID === "virtual"
      ? undefined
      : source.model
    if (!sourceModel) throw new Error("Pi model is not configured; subagents require a model-backed parent session")
    const sourceMeta = await services.projectionStore.session_meta(sourceSessionId)
    const placement: { workspaceId?: string; toolSandbox: SandboxRef } = sessionPlacements.get(sourceSessionId) ?? (sourceMeta ? {
      ...(sourceMeta.workspaceID ? { workspaceId: sourceMeta.workspaceID } : {}),
      toolSandbox: toolSandboxFromMeta(sourceMeta),
    } : {
      toolSandbox: { kind: "virtual", id: "central-pi" } as const,
    })
    if (mode === "background" && (backgroundCounts.get(sourceSessionId) ?? 0) >= 4) {
      throw new Error("a parent session may run at most 4 background subagents")
    }
    if (mode === "background") backgroundCounts.set(sourceSessionId, (backgroundCounts.get(sourceSessionId) ?? 0) + 1)
    const releaseBackgroundSlot = () => {
      if (mode !== "background") return
      const remaining = (backgroundCounts.get(sourceSessionId) ?? 1) - 1
      if (remaining > 0) backgroundCounts.set(sourceSessionId, remaining)
      if (remaining <= 0) backgroundCounts.delete(sourceSessionId)
    }
    const baseObservation = {
      stableCorrelationId: toolCallId,
      toolCallId,
      toolCallRole: "spawn" as const,
      mode,
      label: input.title?.trim() || "Subagent",
      subagentType: "pi",
      description: task,
      providerKind: "pi",
      childSessionId,
      transcript: { kind: "live" as const, ref: childSessionId },
    }
    const pending = await subagentAdmission.admit(sourceSessionId, {
      ...baseObservation,
      observationId: `${toolCallId}:pending`,
      status: "pending",
    }).catch((cause) => {
      releaseBackgroundSlot()
      throw cause
    })
    const subagentKey = pending.subagentKey
    input.onUpdate?.({
      content: [{ type: "text", text: `${baseObservation.label}: pending` }],
      details: { subagentKey, childSessionId, status: "pending" },
    })
    const observe = async (stage: string, status: NonNullable<SubagentObservation["status"]>) => {
      const event = await subagentAdmission.admit(sourceSessionId, {
        ...baseObservation,
        observationId: `${toolCallId}:${stage}`,
        subagentKey,
        status,
      })
      input.onUpdate?.({
        content: [{ type: "text", text: `${baseObservation.label}: ${status}` }],
        details: { subagentKey, childSessionId, status },
      })
      return event
    }
    try {
      await createHybridSession({
        sessionId: childSessionId,
        parentID: sourceSessionId,
        title: input.title?.trim() || "Subagent",
        model: sourceModel,
        requireModel: true,
        admitToolSandbox: false,
        ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
        toolSandbox: placement.toolSandbox,
        subagentKey,
        spawningToolCallId: toolCallId,
      })
    } catch (cause) {
      try {
        await observe("failed-to-create", "failed")
      } finally {
        releaseBackgroundSlot()
      }
      throw cause
    }

    let forcedStatus: "failed" | "killed" | "interrupted" | undefined
    let failure: string | undefined
    let finalText = ""
    const runChild = async () => {
      const unsubscribe = eventHub.subscribeRuntime((event) => {
        if (event.sessionId !== childSessionId) return
        if (event.payload.type === "text-delta") finalText += event.payload.delta
        if (event.payload.type === "error") failure = event.payload.error
        input.onUpdate?.({
          content: [{
            type: "text",
            text: event.payload.type === "text-delta" ? event.payload.delta : `${baseObservation.label}: ${event.payload.type}`,
          }],
          details: { subagentKey, childSessionId, event: event.payload },
        })
      })
      const abort = () => {
        forcedStatus = "interrupted"
        void adapter.abort(childSessionId, undefined)
      }
      if (mode === "foreground") input.signal?.addEventListener("abort", abort, { once: true })
      if (mode === "foreground" && input.signal?.aborted) abort()
      const timeout = mode === "background" ? setTimeout(() => {
        forcedStatus = "failed"
        failure = `background subagent timed out after ${subagentTimeoutMs}ms`
        void adapter.abort(childSessionId, undefined)
      }, subagentTimeoutMs) : undefined
      try {
        await observe("running", "running")
        if (!forcedStatus) {
          const response = await runTurn({ sessionId: childSessionId }, () =>
            placementRoutes.request(`http://127.0.0.1/session/${encodeURIComponent(childSessionId)}/message`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text: task }] }),
            }),
          )
          if (!response.ok && !failure) failure = `child turn failed with HTTP ${response.status}`
        }
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause)
      } finally {
        if (timeout) clearTimeout(timeout)
        input.signal?.removeEventListener("abort", abort)
        unsubscribe()
      }
      const status = forcedStatus ?? (failure ? "failed" : "completed")
      await observe(status, status)
      if (failure && status === "failed") throw new Error(failure)
      return { subagentKey, childSessionId, status, text: finalText }
    }

    if (mode === "foreground") return runChild()
    const tasks = backgroundTasks(sourceSessionId)
    const running = runChild().catch((cause: unknown) => {
      console.error(`[central-runtime] background subagent ${childSessionId} failed:`, cause)
    }).finally(() => {
      tasks.delete(subagentKey)
      if (tasks.size === 0) activeBackgrounds.delete(sourceSessionId)
      releaseBackgroundSlot()
    })
    tasks.set(subagentKey, {
      childSessionId,
      terminate: async (status) => {
        forcedStatus = status
        await adapter.abort(childSessionId, undefined)
        await running
      },
    })
    return { subagentKey, childSessionId, status: "running" as const }
  }

  async function terminateSubagent(parentSessionId: string, subagentKey: string) {
    const task = activeBackgrounds.get(parentSessionId)?.get(subagentKey)
    if (!task) return false
    await task.terminate("killed")
    return true
  }

  async function terminateBackgrounds(parentSessionId: string, status: "killed" | "interrupted") {
    await Promise.all(
      [...(activeBackgrounds.get(parentSessionId)?.values() ?? [])].map((task) => task.terminate(status)),
    )
  }

  // Native Pi tool extension. The child inherits the parent's selected model
  // and exact tools-only placement; no workspace selector is exposed to the model.
  dispatchToolsForSession = (sourceSessionId) => [{
      name: "subagent",
      label: "subagent",
      description: "Delegate a task to an isolated child session. Foreground waits for the result; background returns its stable identity immediately.",
      parameters: Type.Object({
        task: Type.String({ description: "Task for the child session." }),
        title: Type.Optional(Type.String({ description: "Child session title." })),
        background: Type.Optional(Type.Boolean({ description: "Run independently in the background." })),
      }),
      execute: async (toolCallId, params, signal, onUpdate) => {
        const result = await createDispatchedSession(sourceSessionId, {
          ...(params as { task: string; title?: string; background?: boolean }),
          toolCallId,
          ...(signal ? { signal } : {}),
          ...(onUpdate ? { onUpdate } : {}),
        })
        return {
          content: [{
            type: "text",
            text: "text" in result && result.text ? result.text : JSON.stringify({
              subagentKey: result.subagentKey,
              childSessionId: result.childSessionId,
            }),
          }],
          details: result,
        }
      },
    } as PiAgentTool]

  return {
    routes: placementRoutes,
    eventHub,
    /** The compat-event ingress: live hub, turn metering, durable log. */
    publishGlobal,
    runtimeEvents: runtimeEventsHandler(eventHub),
    sourceChannelSessionCountsByWeek: (input?: { channel?: string; includeHidden?: boolean }) =>
      services.projectionStore.source_channel_session_counts_by_week?.(input) ?? Promise.resolve([]),
    createHybridSession,
    createDispatchedSession,
    parentSessionIdFor: (sessionId: string) => {
      const session = runtimeStore.getSession(sessionId) as { parentID?: unknown } | null
      return typeof session?.parentID === "string" ? session.parentID : sessionId
    },
    subagentToolForSession: (sessionId: string) => dispatchToolsForSession(sessionId)[0]!,
    terminateSubagent,
    listSubagents: (parentSessionId: string) => subagentStore.listSubagents(parentSessionId),
    updateSessionModel: async (sessionId: string, model: { providerID: string; modelID: string }) => {
      if (!(await ensureCentralRuntimeSession(sessionId))) throw new Error(`No central session ${sessionId}`)
      const session = runtimeStore.getSession(sessionId)
      if (!session) throw new Error(`No central session ${sessionId}`)
      await adapter.updateSessionConfig(sessionId, { model }, undefined)
      runtimeStore.updateSessionConfig(sessionId, {
        harness: { id: "pi", access: "native" },
        model,
        variant: null,
        agent: null,
      })
    },
    invalidateSession: (sessionId: string) => {
      sessionPlacements.delete(sessionId)
      subagentChildren.delete(sessionId)
      runtimeStore.deleteSession(sessionId)
    },
    turnCredentials,
    runTurn,
    /** Present when CLAXEDO_WAKES=1. The channels/webhook layer calls deliverEvent/resolve. */
    wakes,
  }
}
