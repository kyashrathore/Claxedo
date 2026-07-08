import { randomUUID } from "node:crypto"
import {
  createAgentRuntime,
  type AgentHarnessFactory,
  type AgentMessageRow,
  type AgentRuntimeStore,
  type AgentSessionRow,
  type SandboxRef,
  type SessionEnvFactory,
} from "@claxedo/agent-sdk-runtime"
import {
  codexBundlePiBackendResolver,
  firstPiModelBackend,
  localPiModelBackendResolver,
  PiHarnessAdapter,
  type AgentRuntimeStoreWithRecovery,
  type PiAgentTool,
  type PiModelBackendResolver,
} from "@claxedo/agent-sdk-runtime/adapters"
import { Type } from "@sinclair/typebox"
import { getCredentialByProvider, putCredential, resolveSecret } from "./credentials/registry"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { createRuntimeEventHub } from "@claxedo/agent-sdk-runtime/runtime-event-hub"
import { eventSessionId } from "@claxedo/agent-sdk-runtime/compat-events"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { Hono } from "hono"
import {
  createWakes,
  createScheduler,
  SqliteWakeStore,
  handleWakeToolCall,
  getWakeToolDefinitions,
  type Wakes,
  type WakeResult,
} from "@claxedo/wakes"
import { createSessionRoutes, runtimeEventsHandler, type RuntimeSessionBusEvent } from "@claxedo/workspace-runtime/routes"
import type { ControlPlaneServices } from "./control-plane/services"
import type { SessionMeta } from "./session-meta"

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
}

/** Registry providers that may carry a codex auth bundle, preferred first. */
const CODEX_BUNDLE_PROVIDERS = ["codex-app-server", "codex-acp"] as const

/**
 * Registry-backed codex backend: the bundle arrives via the consent-gated
 * credential sync flow (`claxedo creds sync` → PUT /credentials), so a
 * DEPLOYED box needs no home-dir credential files. Rotated refresh tokens are
 * persisted back onto the same registry credential.
 */
function registryCodexBackend(modelId?: string): PiModelBackendResolver {
  const providerFor = () => CODEX_BUNDLE_PROVIDERS.find((provider) => getCredentialByProvider(provider))
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
function centralModelBackend(): { modelBackend: PiModelBackendResolver } | undefined {
  const model = process.env.CLAXEDO_PI_MODEL?.trim()
  const enabled = (model && model.length > 0) || process.env.CLAXEDO_PI_MODEL_BACKEND === "1"
  if (!enabled) return undefined
  const override = model && model !== "auto" ? model : undefined
  const codexModelId = override?.startsWith("openai-codex/") ? override.slice("openai-codex/".length) : undefined
  return {
    modelBackend: firstPiModelBackend(
      registryCodexBackend(codexModelId),
      localPiModelBackendResolver({
        ...(override ? { modelOverride: override } : {}),
      }),
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
  // Late-bound dispatch tools: the spawn_session tool needs createHybridSession
  // + the message routes, which are built AFTER the adapter. The wrapped
  // resolver reads this array per turn, so pushing after construction is safe.
  const dispatchTools: PiAgentTool[] = []
  // Assigned below (needs placementRoutes + createHybridSession); captured here
  // so each turn gets session-scoped wake tools. Opt-in via CLAXEDO_WAKES=1.
  let wakes: Wakes | undefined
  const baseModelBackend = centralModelBackend()
  const modelBackend: PiModelBackendResolver | undefined = baseModelBackend
    ? async (input) => {
        const backend = await baseModelBackend.modelBackend(input)
        if (!backend) return undefined
        const extraTools = [...(backend.extraTools ?? []), ...dispatchTools]
        if (wakes) {
          const meta = await services.projectionStore.session_meta(input.sessionId)
          const workspaceId = (meta?.workspaceID as string | undefined) ?? input.sessionId
          extraTools.push(...buildWakeTools(wakes, input.sessionId, workspaceId))
        }
        return { ...backend, extraTools }
      }
    : undefined
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
    ...(modelBackend ? { modelBackend } : {}),
    ...(options.createEnv ? { createEnv: options.createEnv } : {}),
  })
  const runtimeStore = createMemoryRuntimeStore() as unknown as AgentRuntimeStoreWithRecovery
  const runtime = createAgentRuntime({
    store: runtimeStore as unknown as AgentRuntimeStore,
    harnesses: [{
      id: "pi",
      access: "native",
      create: () => adapter,
    } as unknown as AgentHarnessFactory],
  })
  const sessionBus = createSessionBus()
  function bindRuntimeSession(input: { id: string; title?: string | null }) {
    runtimeStore.bindSession({
      sessionId: input.id,
      directory: input.id,
      title: input.title ?? undefined,
      agentSessionId: input.id,
    })
    runtimeStore.updateSessionConfig(input.id, {
      harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "virtual" },
      variant: null,
      agent: null,
    })
  }
  async function ensureCentralRuntimeSession(sessionId: string) {
    if (runtimeStore.getSession(sessionId)) return true
    const meta = await services.projectionStore.session_meta(sessionId)
    if (meta?.host !== "central") return false
    await adapter.bindSession({
      id: sessionId,
      title: meta.title ?? null,
      placement: {
        mode: "hybrid",
        host: "central",
        ...(meta.workspaceID ? { workspaceId: meta.workspaceID } : {}),
        toolSandbox: toolSandboxFromMeta(meta),
      },
    })
    bindRuntimeSession({ id: sessionId, title: meta.title ?? null })
    return true
  }
  const routes = createSessionRoutes({
    resolveAdapter: () => adapter,
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
    afterUpdateSession: async (_c, _directory, session) => {
      const row = session as { id?: unknown; title?: unknown; time?: { archived?: number } }
      if (typeof row.id !== "string") return
      bindRuntimeSession({
        id: row.id,
        title: typeof row.title === "string" ? row.title : null,
      })
      await services.projectionStore.put_session_meta(row.id, {
        host: "central",
        directory: null,
        title: typeof row.title === "string" ? row.title : null,
        archived: row.time?.archived ?? null,
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
    publishGlobal: (event: CompatEnvelope) => {
      eventHub.publishGlobal(event)
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
    },
    resolveWorkspaceId: () => undefined,
  })

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
    return c.json({ ok: true, placement: { sessionId, mode: "hybrid", host: "central", workspaceId: workspaceId ?? null, toolSandbox } })
  })
  // Cast: workspace-runtime pins hono 4.10 while this package is on 4.12 —
  // the app contract (fetch) is identical; only the nominal types diverge.
  placementRoutes.route("/", routes as never)

  async function createHybridSession(input: {
    title?: string | null
    workspaceId?: string | null
    toolSandbox?: SandboxRef
    sourceChannel?: SourceChannel
    sourceThreadKey?: string
    /** Harness id; only "pi" is dispatchable centrally today (route-validated). */
    harness?: string
  }) {
    const toolSandbox = virtualToolSandbox(input.toolSandbox)
    const workspaceId = input.workspaceId
      ?? (toolSandbox.kind === "workspace-runtime" ? toolSandbox.workspaceId : undefined)
    const session = await adapter.bindSession({
      id: randomUUID(),
      title: input.title ?? null,
      placement: {
        mode: "hybrid",
        host: "central",
        ...(workspaceId ? { workspaceId } : {}),
        toolSandbox,
      },
    })
    bindRuntimeSession({ id: session.id, title: input.title ?? "Hybrid Session" })
    const tags = [
      ...(input.sourceChannel ? [`source-channel:${input.sourceChannel}`] : []),
      ...(input.sourceThreadKey ? [`source-thread:${input.sourceThreadKey}`] : []),
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
        }
      : null
    await services.projectionStore.put_session_meta(session.id, {
      host: "central",
      ...(workspaceId ? { workspaceID: workspaceId } : {}),
      directory: null,
      ...(storedToolSandbox ? { toolSandbox: storedToolSandbox } : {}),
      title: input.title ?? "Hybrid Session",
      ...(tags.length > 0 ? { tags } : {}),
    })
    return session
  }

  // Wakes: durable out-of-band session resumption. Opt-in; a fired wake spawns a
  // fresh turn on its session by posting an injected message through the same
  // message route the spawn_session tool uses. The scheduler drives time wakes;
  // deliverEvent/resolve are exposed on the return for the channels/webhook layer.
  if (process.env.CLAXEDO_WAKES === "1") {
    const store = new SqliteWakeStore({ path: process.env.CLAXEDO_WAKES_DB || ":memory:" })
    wakes = createWakes({
      store,
      // v1 authz: the 128-bit token is the guard for approvals; wire
      // services.authority for per-workspace resolver checks in a follow-up.
      authorize: () => true,
      spawnTurn: async (sessionId, result) => {
        const target = sessionId ?? (await createHybridSession({ title: "Scheduled Session" })).id
        await placementRoutes.request(`http://127.0.0.1/session/${encodeURIComponent(target)}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: renderWakeResult(result) }] }),
        })
      },
    })
    createScheduler(wakes, {
      onError: (e) => console.error("[central-runtime] wakes scheduler:", e),
    }).start()
  }

  // The central Agent's dispatch tool (acceptance loop: "creates a background
  // session via claxedo-mcp"): in-process equivalent of the claxedo-mcp
  // spawn_session tool — no MCP hop needed for the pi central harness. The
  // initial prompt is fired WITHOUT awaiting the turn (message route runs the
  // whole turn before responding).
  dispatchTools.push({
    name: "spawn_session",
    label: "spawn_session",
    description:
      "Spawn a background Claxedo work session. Model turns run centrally; tool side-effects run in the " +
      "given workspace's runtime (workspace_id) or a virtual sandbox. The initial prompt is dispatched " +
      "fire-and-forget; returns the new session id and app URL.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Session title shown in the app." })),
      prompt: Type.String({ description: "Initial prompt for the background session." }),
      workspace_id: Type.Optional(Type.String({ description: "Workspace whose runtime hosts the session's tools." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { title?: string; prompt: string; workspace_id?: string }
      const workspaceId = args.workspace_id?.trim()
      const session = await createHybridSession({
        title: args.title?.trim() || "Background Session",
        ...(workspaceId ? {
          workspaceId,
          toolSandbox: { kind: "workspace-runtime", workspaceId },
        } : {}),
      })
      void Promise.resolve(placementRoutes.request(`http://127.0.0.1/session/${encodeURIComponent(session.id)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: args.prompt }] }),
      })).catch((err: unknown) => {
        console.error(`[central-runtime] spawn_session initial prompt failed for ${session.id}:`, err)
      })
      const result = { session_id: session.id, app_url: `/s/${encodeURIComponent(session.id)}`, workspace_id: workspaceId ?? null }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
    },
  } as PiAgentTool)

  return {
    routes: placementRoutes,
    eventHub,
    runtimeEvents: runtimeEventsHandler(eventHub),
    sourceChannelSessionCountsByWeek: (input?: { channel?: string; includeHidden?: boolean }) =>
      services.projectionStore.source_channel_session_counts_by_week?.(input) ?? Promise.resolve([]),
    createHybridSession,
    /** Present when CLAXEDO_WAKES=1. The channels/webhook layer calls deliverEvent/resolve. */
    wakes,
  }
}
