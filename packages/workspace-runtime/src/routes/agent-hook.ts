/**
 * Agent Hook Routes
 *
 * Receives lifecycle hook callbacks from CLI agents (Claude, Codex, etc.)
 * running in terminals and publishes events to the runtime event bus.
 */

import { Hono, type Context } from "hono"
import z from "zod/v3"
import { workspaceRuntimeBus } from "../bus"
import { Log } from "../log"
import { bearerToken, boundedJsonBody, boundedJsonRecord, boundedTextBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { arr, bool, num, str, parseRecord } from "../json-value"
import { providerLifecycle } from "../agent-hooks/provider-lifecycle"
import {
  setupAgentHooks,
  getTerminalEnvVars,
  isSetupComplete,
  listWrapperAgents,
} from "../agent-hooks"
import { Pty } from "../pty/index"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import {
  sessionAccessContext,
  sessionAccessDenied,
} from "../session-access-policy"
import { authorizeHostCapability, type HostCapabilityAccessOptions } from "./host-capability-access"

const log = Log.create({ service: "agent-hook" })

export const AgentEventType = z.enum(["Busy", "Idle", "UserActionRequired", "Error"])
export type AgentEventType = z.infer<typeof AgentEventType>

const AgentEventInputType = z.enum([
  "Busy",
  "Idle",
  "UserActionRequired",
  "Error",
  "Start",
  "Stop",
  "PermissionRequest",
  "QuestionRequest",
  "Failed",
  "SessionStart",
  "SessionEnd",
])

const normalizeAgentEventType = (value: unknown): AgentEventType | undefined => {
  const parsed = AgentEventInputType.safeParse(value)
  if (!parsed.success) return undefined
  if (parsed.data === "Start" || parsed.data === "SessionStart") return "Busy"
  if (parsed.data === "Stop" || parsed.data === "SessionEnd") return "Idle"
  if (parsed.data === "PermissionRequest" || parsed.data === "QuestionRequest") return "UserActionRequired"
  if (parsed.data === "Failed") return "Error"
  return parsed.data
}

const lifecycleId = z.string().max(512)
const lifecyclePath = z.string().max(4_096)
const lifecyclePrompt = z.string().max(800)
const lifecycleAssistantMessage = z.string().max(1_500)

export const AgentLifecyclePayload = z.object({
  tabId: lifecycleId.trim().min(1),
  terminalId: lifecycleId.optional(),
  workspaceId: lifecycleId.optional(),
  provider: lifecycleId.optional(),
  sessionId: lifecycleId.optional(),
  transcriptPath: lifecyclePath.optional(),
  refName: lifecycleId.optional(),
  prompt: lifecyclePrompt.optional(),
  lastAssistantMessage: lifecycleAssistantMessage.optional(),
  eventType: AgentEventType,
  outcome: z.enum(["done", "error", "cancelled"]).optional(),
})
export type AgentLifecyclePayload = z.infer<typeof AgentLifecyclePayload>

const AgentLifecycleInputPayload = AgentLifecyclePayload.extend({
  eventType: AgentEventInputType,
})

const ProviderLifecycleInputPayload = AgentLifecyclePayload.omit({ eventType: true }).extend({
  providerEvent: z.string(),
})

const TerminalSessionPayload = z.object({
  terminalId: lifecycleId,
  tabId: lifecycleId.optional(),
  workspaceId: lifecycleId.optional(),
  provider: lifecycleId.optional(),
  providerSessionId: lifecycleId.nullable().optional(),
  sessionId: lifecycleId.nullable().optional(),
  transcriptPath: lifecyclePath.nullable().optional(),
  refName: lifecycleId.optional(),
  prompt: lifecyclePrompt.optional(),
  lastAssistantMessage: lifecycleAssistantMessage.optional(),
  eventType: AgentEventType.optional(),
  updatedAt: z.number(),
})
type TerminalSessionPayload = z.infer<typeof TerminalSessionPayload>
type PendingUserAction = string | null
type TerminalSessionRecord = TerminalSessionPayload & {
  ownerActorId?: string
  pendingUserActions?: PendingUserAction[]
}

const TERMINAL_SESSION_TTL_MS = (() => {
  const v = Number(process.env.WORKSPACE_RUNTIME_TERMINAL_SESSION_TTL_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 30 * 24 * 60 * 60 * 1000
})()

const terminalSessions = new Map<string, TerminalSessionRecord>()

export const TERMINAL_SESSION_MAX_ENTRIES = (() => {
  const value = Number(process.env.WORKSPACE_RUNTIME_TERMINAL_SESSION_MAX_ENTRIES)
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_024) : 256
})()

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "")

export const lifecycleLogMetadata = (payload: AgentLifecyclePayload) => ({
  tabId: payload.tabId,
  terminalId: payload.terminalId,
  workspaceId: payload.workspaceId,
  provider: payload.provider,
  sessionId: payload.sessionId,
  eventType: payload.eventType,
  hasPrompt: !!payload.prompt,
  hasLastAssistantMessage: !!payload.lastAssistantMessage,
})

const normalizeProvider = (value: unknown) => clean(value).toLowerCase()

const REF_STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "with",
  "from",
  "by",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "please",
  "can",
  "you",
  "me",
  "my",
  "we",
  "our",
  "do",
  "does",
  "did",
  "help",
])

const refWords = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 2)
    .filter((w) => !REF_STOP.has(w))

const weakText = (value: string) => /^(hi|hello|hey|yo|greeting|greetings)$/i.test(clean(value).replace(/[^a-z0-9]+/gi, " ").trim())

const noisyPromptText = (value: string) => {
  const text = clean(value)
  return text.length > 160 || /\b(i'?m|i am)\s+(claude|codex)\b/i.test(text) || /\bai assistant\b/i.test(text)
}

const weakRefName = (value: string) => {
  const ref = clean(value)
    .replace(/^@+/, "")
    .replace(/[-_][a-z0-9]{4,8}$/i, "")
    .replace(/[-_]+/g, " ")
  return weakText(ref)
}

const refNameFrom = (input: { prompt?: string; assistant?: string; provider?: string; sessionId?: string }) => {
  const prompt = clean(input.prompt)
  const assistant = clean(input.assistant)
  const provider = normalizeProvider(input.provider) || "agent"
  const sessionId = clean(input.sessionId)
  const source = prompt && !(assistant && (weakText(prompt) || noisyPromptText(prompt))) ? prompt : assistant || prompt
  const tokens = refWords(source).slice(0, 3)
  const base = (tokens.join("-") || provider || "agent").slice(0, 26).replace(/^-+|-+$/g, "") || "agent"
  const suffix = sessionId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(-4)
  return `@${suffix ? `${base}-${suffix}` : base}`
}

const resolveTerminalId = (input: { terminalId?: string; tabId?: string }) => {
  return clean(input.terminalId)
}

const pruneTerminalSessions = () => {
  const now = Date.now()
  for (const [terminalId, session] of terminalSessions.entries()) {
    if (now - session.updatedAt <= TERMINAL_SESSION_TTL_MS) continue
    terminalSessions.delete(terminalId)
  }
}

const rememberTerminalSession = (session: TerminalSessionRecord) => {
  terminalSessions.delete(session.terminalId)
  terminalSessions.set(session.terminalId, session)
  while (terminalSessions.size > TERMINAL_SESSION_MAX_ENTRIES) {
    const oldest = terminalSessions.keys().next().value
    if (oldest === undefined) break
    terminalSessions.delete(oldest)
  }
}

const upsertTerminalSession = (input: {
  terminalId: string
  tabId?: string
  workspaceId?: string
  provider?: string
  providerSessionId?: string
  sessionId?: string
  clearSessionId?: boolean
  transcriptPath?: string
  refName?: string
  prompt?: string
  lastAssistantMessage?: string
  eventType?: AgentEventType
  ownerActorId?: string
  pendingUserActions?: PendingUserAction[]
  /**
   * A tool-scoped hook reports the conversation that ran the tool, which for a
   * subagent's shell command is the child's id. Only turn boundaries may bind
   * the terminal to a session.
   */
  toolScoped?: boolean
}) => {
  pruneTerminalSessions()
  const terminalId = clean(input.terminalId)
  if (!terminalId) return undefined
  const found = terminalSessions.get(terminalId)
  const verifiedOwner = clean(input.ownerActorId)
  // A managed terminal never inherits metadata written before its verified
  // owner binding. This prevents an untrusted local/legacy hook row with a
  // guessed terminal id from seeding provider, transcript, prompt, or Session
  // scope into the managed record.
  const previous = verifiedOwner && found?.ownerActorId !== verifiedOwner ? undefined : found
  const bound = input.toolScoped && clean(previous?.providerSessionId)
  const providerSessionId = bound ? clean(previous?.providerSessionId) : clean(input.providerSessionId)
  const sessionId = bound ? clean(previous?.sessionId) : clean(input.sessionId)
  const transcriptPath = clean(input.transcriptPath)
  const refName = clean(input.refName)
  const prompt = clean(input.prompt)
  const lastAssistantMessage = clean(input.lastAssistantMessage)
  const provider = normalizeProvider(input.provider) || normalizeProvider(previous?.provider)
  const trackedSessionId = providerSessionId || sessionId
  const previousSessionId = clean(previous?.providerSessionId) || clean(previous?.sessionId)
  const sessionChanged = !!trackedSessionId && trackedSessionId !== previousSessionId
  const sessionRefName =
    refName ||
    (!sessionChanged && clean(previous?.refName) && !(weakRefName(clean(previous?.refName)) && lastAssistantMessage)
      ? clean(previous?.refName)
      : "") ||
    refNameFrom({
      prompt: prompt || (sessionChanged ? "" : clean(previous?.prompt)),
      assistant: lastAssistantMessage || (sessionChanged ? "" : clean(previous?.lastAssistantMessage)),
      provider,
      sessionId: trackedSessionId || previousSessionId,
    })
  const next: TerminalSessionRecord = {
    terminalId,
    tabId: clean(input.tabId) || clean(previous?.tabId) || undefined,
    workspaceId: clean(input.workspaceId) || clean(previous?.workspaceId) || undefined,
    provider: provider || undefined,
    providerSessionId: providerSessionId ? providerSessionId : previous?.providerSessionId,
    sessionId: input.clearSessionId ? undefined : sessionId ? sessionId : previous?.sessionId,
    transcriptPath: transcriptPath ? transcriptPath : previous?.transcriptPath,
    refName: sessionRefName,
    prompt: prompt ? prompt : sessionChanged ? undefined : clean(previous?.prompt) || undefined,
    lastAssistantMessage: lastAssistantMessage
      ? lastAssistantMessage
      : sessionChanged
        ? undefined
        : clean(previous?.lastAssistantMessage) || undefined,
    eventType: input.eventType || previous?.eventType,
    ownerActorId: input.ownerActorId || previous?.ownerActorId,
    pendingUserActions: input.pendingUserActions ?? previous?.pendingUserActions,
    updatedAt: Date.now(),
  }
  rememberTerminalSession(next)
  return next
}

/**
 * A raw CLI hook stream interleaves the asks of one tool with the completions
 * of others: Cursor and Claude run read-only tools while a shell command waits
 * for approval, and Cursor also replays Claude-compat PostToolUse hooks. A
 * completion therefore only retires the ask it pairs with; while any ask is
 * still open the terminal stays on UserActionRequired. Turn boundaries and a
 * new prompt retire every ask.
 */
function settlePendingUserActions(input: {
  pending: readonly PendingUserAction[]
  eventType: AgentEventType
  userAction?: { toolKey: PendingUserAction }
  toolCompletion?: { toolKey: PendingUserAction }
}): { pending: PendingUserAction[]; held: boolean } {
  if (input.eventType === "UserActionRequired") {
    return { pending: [...input.pending, input.userAction?.toolKey ?? null], held: false }
  }
  if (input.eventType !== "Busy" || !input.toolCompletion || input.pending.length === 0) {
    return { pending: [], held: false }
  }
  const key = input.toolCompletion.toolKey
  const pending = [...input.pending]
  const index = key === null ? 0 : pending.findIndex((entry) => entry === key || entry === null)
  if (index >= 0) pending.splice(index, 1)
  return { pending, held: pending.length > 0 }
}

const clearTerminalSession = (terminalId: string) => {
  pruneTerminalSessions()
  const id = clean(terminalId)
  if (!id) return undefined
  const previous = terminalSessions.get(id)
  const next: TerminalSessionRecord = {
    terminalId: id,
    tabId: clean(previous?.tabId) || undefined,
    workspaceId: clean(previous?.workspaceId) || undefined,
    provider: normalizeProvider(previous?.provider) || undefined,
    providerSessionId: previous?.providerSessionId,
    sessionId: null,
    transcriptPath: null,
    refName: clean(previous?.refName) || undefined,
    prompt: clean(previous?.prompt) || undefined,
    lastAssistantMessage: clean(previous?.lastAssistantMessage) || undefined,
    eventType: "Idle",
    ownerActorId: previous?.ownerActorId,
    updatedAt: Date.now(),
  }
  rememberTerminalSession(next)

  // Emit Idle event to frontend so the status indicator clears
  if (previous && previous.eventType && previous.eventType !== "Idle") {
    workspaceRuntimeBus.publish({
      type: "agent.lifecycle",
      tabId: next.tabId || id,
      terminalId: id,
      workspaceId: next.workspaceId,
      eventType: "Idle",
    })
  }

  return next
}

const readTerminalSession = (input: { terminalId?: string; tabId?: string }) => {
  pruneTerminalSessions()
  const terminalId = resolveTerminalId(input)
  if (!terminalId) return undefined
  const mapped = terminalSessions.get(terminalId)
  if (!mapped) return undefined
  const { ownerActorId: _ownerActorId, pendingUserActions: _pendingUserActions, ...session } = mapped
  return { source: "memory" as const, terminalId, session }
}

// Subscribe to PTY exit/delete events to clear terminal sessions
workspaceRuntimeBus.subscribe((event) => {
  if (event.type === "pty.exited") {
    clearTerminalSession(event.id)
  } else if (event.type === "pty.deleted") {
    clearTerminalSession(event.id)
  }
})

export type AgentHookRoutesOptions = HostCapabilityAccessOptions

type AgentHookContext = ReturnType<typeof sessionAccessContext>

function lifecycleContext(
  c: Context<{ Variables: RelayHostAuthContext }>,
  terminalId: string,
): {
  context: AgentHookContext
  capability?: ReturnType<typeof Pty.agentHookAccessForToken>
} {
  const verified = sessionAccessContext(c)
  if (verified.authority) return { context: verified }
  if (!c.get("relayHostDirectAuth")) return { context: verified }
  const token = bearerToken(c.req.header("authorization"))
  const access = token ? Pty.agentHookAccessForToken(token) : undefined
  if (!access || access.terminalId !== terminalId) return { context: verified }
  return { context: access.context, capability: access }
}

function terminalPrivate() {
  return sessionAccessDenied({
    allowed: false,
    status: 403,
    code: "agent_terminal_private",
    message: "Agent terminal access requires its creator or a workspace administrator",
  })
}

function canAdminister(context: AgentHookContext) {
  return context.authority?.role === "admin" || context.authority?.role === "owner"
}

async function authorizeTerminal(
  c: Context<{ Variables: RelayHostAuthContext }>,
  options: AgentHookRoutesOptions,
  input: {
    operation: "agent_lifecycle_read" | "agent_lifecycle_write"
    terminalId: string
    context?: AgentHookContext
    capability?: NonNullable<ReturnType<typeof Pty.agentHookAccessForToken>>
  },
): Promise<{ context: AgentHookContext } | { response: Response }> {
  const context = input.context ?? sessionAccessContext(c)
  if (input.capability) {
    const info = Pty.get(input.terminalId)
    if (
      input.operation !== "agent_lifecycle_write"
      || info?.status !== "running"
      || info.sessionId !== input.capability.sessionId
      || !options.sessionAccessPolicy?.authorizeStream
    ) return { response: terminalPrivate() }
    const renewed = await options.sessionAccessPolicy.authorizeStream({
      ...context,
      operation: input.operation,
      sessionId: input.capability.sessionId,
      method: c.req.method,
      path: c.req.path,
    }, input.capability.authorityLease)
    if (!renewed.allowed) return { response: sessionAccessDenied(renewed) }
    if (!Pty.renewAgentHookAccess(input.capability.token, {
      authorityLease: renewed.lease,
      authorityExpiresAt: renewed.expiresAt,
    })) return { response: terminalPrivate() }
  } else {
    const denied = await authorizeHostCapability(c, options, input.operation, context, Pty.get(input.terminalId)?.sessionId)
    if (denied) return { response: denied }
  }
  const storedOwner = terminalSessions.get(input.terminalId)?.ownerActorId
  const runtimeOwner = Pty.accessOwner(input.terminalId)
  const writing = input.operation === "agent_lifecycle_write"
  const owner = writing
    ? Pty.get(input.terminalId)?.status === "running" ? runtimeOwner : undefined
    : storedOwner ?? runtimeOwner
  if (!context.authority) return owner ? { response: terminalPrivate() } : { context }
  if (!context.actor || !input.terminalId || !owner) return { response: terminalPrivate() }
  if (owner !== context.actor.actorId && (writing || !canAdminister(context))) {
    return { response: terminalPrivate() }
  }
  return { context }
}

export function AgentHookRoutes(options: AgentHookRoutesOptions = {}) {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    .get("/agent-lifecycle", (c) => {
      c.header("allow", "POST")
      return c.json({ success: false, error: "Agent lifecycle producers must use POST" }, 405)
    })
    .post("/agent-lifecycle", async (c) => {
      const body = c.req.header("content-type")?.includes("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(await boundedTextBody(c)))
        : await boundedJsonBody(c)
      const parsed = z.union([ProviderLifecycleInputPayload, AgentLifecycleInputPayload]).safeParse(body)
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid payload" }, 400)
      }
      const raw = "providerEvent" in parsed.data ? parsed.data.providerEvent : undefined
      const input = raw === undefined ? undefined : parseRecord(raw)
      if (raw !== undefined && !input) return c.json({ success: false, error: "Invalid provider event JSON" }, 400)
      const providerEvent = input ? providerLifecycle(input) : undefined
      const payload = raw === undefined ? parsed.data : {
        ...parsed.data,
        ...providerEvent,
        provider: parsed.data.provider || providerEvent?.provider,
      }
      const eventType = "eventType" in payload ? normalizeAgentEventType(payload.eventType) : undefined
      if (eventType && !AgentLifecyclePayload.safeParse({ ...payload, eventType }).success) {
        return c.json({ success: false, error: "Invalid provider lifecycle fields" }, 400)
      }

      const resolvedTerminalId = resolveTerminalId({
        tabId: payload.tabId,
        terminalId: payload.terminalId,
      })
      const lifecycleAccess = lifecycleContext(c, resolvedTerminalId)
      const access = await authorizeTerminal(c, options, {
        operation: "agent_lifecycle_write",
        terminalId: resolvedTerminalId,
        context: lifecycleAccess.context,
        ...(lifecycleAccess.capability ? { capability: lifecycleAccess.capability } : {}),
      })
      if ("response" in access) return access.response
      if (!eventType) return c.json({ success: true, ignored: true })
      // Only the raw CLI producer uses settled-event deduplication. Perform it
      // after authorization, against the accepted state rather than a shell file.
      const previous = terminalSessions.get(resolvedTerminalId)
      if (raw !== undefined && (eventType === "Idle" || eventType === "Error") && previous?.eventType === eventType) {
        return c.json({ success: true, duplicate: true })
      }
      const settled = raw === undefined ? undefined : settlePendingUserActions({
        pending: previous?.pendingUserActions ?? [],
        eventType,
        ...(providerEvent?.userAction ? { userAction: providerEvent.userAction } : {}),
        ...(providerEvent?.toolCompletion ? { toolCompletion: providerEvent.toolCompletion } : {}),
      })
      if (settled?.held && previous) {
        rememberTerminalSession({ ...previous, pendingUserActions: settled.pending })
        return c.json({ success: true, held: true })
      }
      const workspaceId = access.context.authority?.workspaceId ?? (clean(payload.workspaceId) || undefined)
      const toolScoped = !!(providerEvent?.userAction || providerEvent?.toolCompletion)
      const providerSessionId = clean(payload.sessionId) || undefined
      const sessionId = access.context.authority ? Pty.get(resolvedTerminalId)?.sessionId : providerSessionId

      // A managed session-less status event must not recover content from a
      // prior terminal mapping merely because it guessed the terminal id.
      const stored = resolvedTerminalId
        ? upsertTerminalSession({
            terminalId: resolvedTerminalId,
            tabId: payload.tabId,
            workspaceId,
            provider: payload.provider,
            providerSessionId,
            sessionId,
            transcriptPath: payload.transcriptPath,
            refName: payload.refName,
            prompt: payload.prompt,
            lastAssistantMessage: payload.lastAssistantMessage,
            eventType,
            ownerActorId: access.context.actor?.actorId,
            ...(settled ? { pendingUserActions: settled.pending } : {}),
            toolScoped,
          })
        : undefined

      const normalized = {
        ...payload,
        terminalId: resolvedTerminalId || clean(payload.terminalId) || undefined,
        workspaceId,
        provider: normalizeProvider(payload.provider) || undefined,
        providerSessionId: toolScoped ? stored?.providerSessionId || providerSessionId : providerSessionId,
        sessionId: toolScoped ? stored?.sessionId || sessionId : sessionId,
        transcriptPath: clean(payload.transcriptPath) || undefined,
        refName: stored?.refName || clean(payload.refName) || undefined,
        prompt: stored?.prompt || clean(payload.prompt) || undefined,
        lastAssistantMessage: stored?.lastAssistantMessage || clean(payload.lastAssistantMessage) || undefined,
        eventType,
      }
      // Raw provider input is an ingestion detail, never a UI event or stored field.
      const published = { ...AgentLifecyclePayload.parse(normalized), providerSessionId: normalized.providerSessionId }

      log.info("agent lifecycle (POST)", lifecycleLogMetadata(published))
      workspaceRuntimeBus.publish({ type: "agent.lifecycle", ...published })

      return c.json({
        success: true,
        tabId: normalized.tabId,
        terminalId: normalized.terminalId,
        provider: normalized.provider,
        sessionId: normalized.sessionId,
        refName: normalized.refName,
        eventType,
      })
    })
    .get("/terminal-session", async (c) => {
      const tabId = c.req.query("tabId")
      const terminalId = c.req.query("terminalId")
      if (!clean(tabId) && !clean(terminalId)) {
        return c.json({ success: false, error: "tabId or terminalId is required" }, 400)
      }
      const resolvedTerminalId = resolveTerminalId({ tabId, terminalId }) || clean(terminalId)
      const terminalAccess = await authorizeTerminal(c, options, {
        operation: "agent_lifecycle_read",
        terminalId: resolvedTerminalId,
      })
      if ("response" in terminalAccess) return terminalAccess.response
      const result = readTerminalSession({ tabId, terminalId })
      if (!result) {
        return c.json({
          success: true,
          source: "none",
          terminalId: resolvedTerminalId || undefined,
          session: null,
        })
      }
      return c.json({
        success: true,
        source: result.source,
        terminalId: result.terminalId,
        session: result.session,
      })
    })
    .post("/setup", async (c) => {
      const denied = await authorizeHostCapability(c, options, "agent_setup_write")
      if (denied) return denied
      const context = sessionAccessContext(c)
      if (context.authority && !canAdminister(context)) {
        return sessionAccessDenied({
          allowed: false,
          status: 403,
          code: "agent_setup_forbidden",
          message: "Agent hook setup requires workspace owner or administrator authority",
        })
      }
      try {
        const body = await boundedJsonRecord(c)
        await setupAgentHooks({
          port: num(body.port),
          force: bool(body.force),
          wrappers: arr(body.wrappers)?.flatMap((item) => str(item) ?? []),
          replaceWrappers: bool(body.replaceWrappers),
        })
        const wrappers = await listWrapperAgents()
        return c.json({
          success: true,
          message: "Agent hooks initialized successfully",
          wrappers: wrappers.all,
          customWrappers: wrappers.custom,
        })
      } catch (error) {
        log.error("Setup failed", { error })
        return c.json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, 500)
      }
    })
    .get("/setup/status", async (c) => {
      const denied = await authorizeHostCapability(c, options, "agent_setup_read")
      if (denied) return denied
      const wrappers = await listWrapperAgents()
      return c.json({
        ready: isSetupComplete(),
        wrappers: wrappers.all,
        customWrappers: wrappers.custom,
      })
    })
    .get("/terminal-env", async (c) => {
      const tabId = c.req.query("tabId")
      const terminalId = c.req.query("terminalId")
      const workspaceId = c.req.query("workspaceId")
      const portStr = c.req.query("port")
      const shell = c.req.query("shell")

      if (!tabId || !terminalId || !portStr) {
        return c.json({ success: false, error: "tabId, terminalId, and port are required" }, 400)
      }
      const port = Number(portStr)
      if (!Number.isFinite(port) || port <= 0) {
        return c.json({ success: false, error: "Invalid port" }, 400)
      }
      const access = await authorizeTerminal(c, options, {
        operation: "agent_lifecycle_read",
        terminalId,
      })
      if ("response" in access) return access.response
      const agentHookToken = access.context.actor?.actorId === Pty.accessOwner(terminalId)
        ? Pty.agentHookToken(terminalId)
        : undefined
      const env = getTerminalEnvVars({
        tabId,
        terminalId,
        workspaceId: access.context.authority?.workspaceId ?? workspaceId ?? "",
        port,
        shell,
        ...(access.context.authority && agentHookToken
          ? { agentHookToken }
          : {}),
      })
      return c.json(env)
    })
}
