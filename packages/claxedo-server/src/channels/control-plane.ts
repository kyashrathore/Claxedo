import { eventSessionId } from "@claxedo/agent-sdk-runtime/compat-events"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import {
  ChannelSessionResolutionError,
  createBaileysWhatsAppSocket,
  createChannelAccess,
  createChannelCore,
  createChannelRegistry,
  createChannelsIngress,
  createChatSdkChannelBot,
  createMemoryApprovalBridge,
  createSlidingWindowRateLimiter,
  createWhatsAppBaileysTransport,
  parseDmPolicy,
  parseGroupEngagement,
  parseGroupPolicy,
  rateLimitKey,
  sanitizeChannelText,
  type ChannelDenialReason,
  type ChannelId,
  type ChannelAccessStore,
  type ChannelIdentityBindingStore,
  type ChatSdkBot,
  type SessionRef,
  type SessionResolver,
  type ChannelTextMinimizationOptions,
  type WhatsAppBaileysSocket,
  type InboundEnvelope,
} from "@claxedo/channels"
import { createSqliteChannelAccessStore, createSqliteChannelIdentityBindingStore } from "./access-store"
import type { Hono as HonoType } from "hono"
import type { createCentralControlApp } from "../central-runtime"
import { createProjectionDedupStore } from "./dedup"
import type { ControlPlaneServices } from "../authority/services"
import type { ProjectAction } from "@claxedo/server-core/platform/auth/authority"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { signedOrError } from "../workspace/route-support"
import { resolveWorkspace, resolveWorkspaceByRepo, type Workspace } from "@claxedo/server-core/workspace/store/index"
import { createCredentialWhatsAppBaileysAuthStateStore } from "./whatsapp-baileys-auth-state"

type CentralRuntime = ReturnType<typeof createCentralControlApp>["runtime"]

function centralRuntimeRequest(pathname: string, body?: unknown) {
  return new Request(`http://claxedo.local${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function assistantMessageUpdate(input: unknown) {
  if (!input || typeof input !== "object") return false
  const event = input as { type?: unknown; properties?: { info?: { role?: unknown } } }
  return event.type === "message.updated" && event.properties?.info?.role === "assistant"
}

function channelDataMinimization(env: Record<string, string | undefined>): ChannelTextMinimizationOptions {
  const maxLength = Number(env.CLAXEDO_CHANNEL_REPLY_MAX_LENGTH)
  return Number.isInteger(maxLength) && maxLength > 0 ? { maxLength } : {}
}

function repoTarget(input: string | undefined) {
  const match = input?.match(/^([^/]+)\/([^/]+)$/)
  if (!match?.[1] || !match[2]) return
  return { owner: match[1], name: match[2] }
}

function channelId(input: unknown): ChannelId | undefined {
  const value = typeof input === "string" ? input : undefined
  if (value === "github" || value === "slack" || value === "telegram" || value === "discord" || value === "whatsapp") return value
}

function channelFromThreadKey(input: string | undefined): ChannelId | undefined {
  return channelId(input?.split(":")[0])
}

async function channelWorkspace(input: { workspaceId?: string }) {
  const repo = repoTarget(input.workspaceId)
  return input.workspaceId
    ? await (repo
      ? resolveWorkspaceByRepo(repo).then((hit) => hit ?? resolveWorkspace({ workspaceId: input.workspaceId }))
      : resolveWorkspace({ workspaceId: input.workspaceId })).catch(() => undefined)
    : undefined
}

function signedChannelAuthRequired(services: ControlPlaneServices) {
  return services.auth.config.enabled
}

async function authorizeChannelWorkspace(input: {
  services: ControlPlaneServices
  channel: ChannelId
  externalUserId: string
  threadKey: string
  workspace?: Workspace
  workspaceId?: string
  action: ProjectAction
}) {
  if (!signedChannelAuthRequired(input.services)) return { ok: true as const }
  const authority = input.services.authority
  if (!authority) return { ok: false as const, message: "Channel identity authorization is not configured." }
  const workspaceId = input.workspace?.id ?? input.workspaceId
  if (!workspaceId) return { ok: false as const, message: "Mention a registered repo or continue an authorized channel session." }
  const projectId = input.workspace?.project_id
  if (projectId) {
    const result = await authority.authorizeChannelProject({
      channel: input.channel,
      externalUserId: input.externalUserId,
      threadKey: input.threadKey,
      projectId,
      action: input.action,
    })
    return result.ok
      ? { ok: true as const }
      : { ok: false as const, message: "Your linked channel account does not have access to this project." }
  }
  await authority.authorizeChannelWorkspace({
    channel: input.channel,
    externalUserId: input.externalUserId,
    threadKey: input.threadKey,
    workspaceId,
    action: input.action,
  })
  return { ok: true as const }
}

async function authorizeInbound(input: {
  services: ControlPlaneServices
  envelope: InboundEnvelope
  session?: Awaited<ReturnType<SessionResolver["get"]>>
  action: ProjectAction
}) {
  const workspace = input.session?.workspaceId
    ? await channelWorkspace({ workspaceId: input.session.workspaceId })
    : input.envelope.repo
      ? await channelWorkspace({ workspaceId: `${input.envelope.repo.owner}/${input.envelope.repo.name}` })
      : undefined
  // FAIL CLOSED on an unresolved sender-named repo. The sender chose this repo
  // string ("repo:owner/name" in their message), so letting an unresolvable one
  // through skipped authorization entirely and fell back to whatever the thread
  // already had — a sender could name a nonexistent repo to dodge the project
  // check. A repo that resolves to no workspace is refused, and session
  // creation would refuse it moments later anyway.
  if (input.envelope.repo && !workspace) {
    return {
      ok: false as const,
      message: `No registered workspace for ${input.envelope.repo.owner}/${input.envelope.repo.name}. Open or register it in Claxedo, then retry.`,
    }
  }
  return authorizeChannelWorkspace({
    services: input.services,
    channel: input.envelope.channel,
    externalUserId: input.envelope.externalUserId,
    threadKey: input.envelope.threadKey,
    workspace,
    workspaceId: input.session?.workspaceId,
    action: input.action,
  }).catch((error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : "Unable to authorize channel identity.",
  }))
}

async function* centralSessionRouteEvents(input: {
  sessionId: string
  request: Promise<Response>
  subscribe: (fn: (event: CompatEnvelope) => void) => () => void
}) {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let done = false
  let emittedMessageUpdate = false
  const unsubscribe = input.subscribe((event) => {
    if (eventSessionId(event.payload) !== input.sessionId) return
    if (assistantMessageUpdate(event.payload)) emittedMessageUpdate = true
    queue.push(event.payload)
    wake?.()
  })
  const response = input.request.finally(() => {
    done = true
    wake?.()
  })

  try {
    while (!done || queue.length > 0) {
      const event = queue.shift()
      if (event) {
        yield event
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = undefined
    }

    const res = await response.catch(() => undefined)
    if (!res) {
      yield { type: "error", error: "Channel session message failed" }
      return
    }
    const body = await res.json().catch(() => undefined)
    if (!res.ok || !body) {
      yield { type: "error", error: "Channel session message failed" }
      return
    }
    if (!emittedMessageUpdate) yield { type: "message.updated", properties: body }
  } finally {
    unsubscribe()
  }
}

/**
 * In-chat pairing administration requires an EXPLICIT env-seeded owner id —
 * NOT merely being on the allowlist (which may contain a wildcard, or paired
 * users). Wildcards never grant admin. This is stricter than access-gate
 * membership on purpose: approving a pairing binds a real account, so it must
 * be the box owner, not any allowed sender (OpenClaw's owner-bootstrap lesson —
 * approval must not be self-granting).
 */
function seedAdmin(allowFrom: string[], channel: string, externalUserId: string): boolean {
  const exact = `${channel}:${externalUserId}`
  return allowFrom.some((entry) => entry.trim() === exact)
}

export function createControlPlaneChannels(input: {
  services: ControlPlaneServices
  runtime: CentralRuntime
  env?: Record<string, string | undefined>
  includeFake?: boolean
  chatBot?: ChatSdkBot | Promise<ChatSdkBot>
  whatsappBaileysSocket?: WhatsAppBaileysSocket | Promise<WhatsAppBaileysSocket | undefined>
  whatsappBaileysQrHandler?: (qr: string) => void
  /** Explicit storage ports for isolated service compositions and tests. */
  accessStore?: ChannelAccessStore
  identityBindingStore?: ChannelIdentityBindingStore
}) {
  const env = input.env ?? process.env
  // Fail-closed posture check (OpenClaw's webhook-secret CVE series #13116 et al.):
  // a PUBLIC box (0.0.0.0) serving a Telegram bot without a webhook secret would
  // accept forged updates. The chat SDK enforces the secret per-request and 401s
  // on mismatch; this is a loud boot-time nudge so the secret is never omitted.
  const isPublic = (env.CLAXEDO_SERVER_HOST?.trim() || "127.0.0.1") === "0.0.0.0"
  const hasTelegram = !!(env.TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_CLAXEDO_BOT_TOKEN?.trim())
  const hasWebhookSecret = !!env.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim()
  if (isPublic && hasTelegram && !hasWebhookSecret) {
    console.error(
      "[channels] SECURITY: public instance serving Telegram without TELEGRAM_WEBHOOK_SECRET_TOKEN — " +
        "webhook updates are unauthenticated and forgeable. Set the secret and re-register the webhook.",
    )
  }
  const channelRuntime = {
    async createSession(request: {
      title: string
      channel: ChannelId
      threadKey: string
      externalUserId: string
      workspaceId?: string
    }) {
      const workspace = await channelWorkspace({ workspaceId: request.workspaceId })
      if (request.workspaceId && !workspace) {
        throw new ChannelSessionResolutionError(
          `No registered workspace for ${request.workspaceId}. Open or register this workspace in Claxedo, then retry. Auto-provisioning a workspace from a bare repo is not enabled.`,
        )
      }
      const session = await input.runtime.createHybridSession({
        title: request.title,
        ...(workspace ? { workspaceId: workspace.id } : {}),
        sourceChannel: request.channel,
        sourceThreadKey: request.threadKey,
      })
      return {
        sessionId: session.id,
        appUrl: `/s/${encodeURIComponent(session.id)}`,
        ...(workspace ? {
          workspaceId: workspace.id,
          workspaceRef: workspace.git_branch ? `branch ${workspace.git_branch}` : "current registered checkout",
        } : {}),
      }
    },
    async *sendMessage(request: {
      sessionId: string
      text: string
      channel: ChannelId
      externalUserId: string
    }) {
      yield* centralSessionRouteEvents({
        sessionId: request.sessionId,
        subscribe: input.runtime.eventHub.subscribeGlobal,
        request: Promise.resolve(input.runtime.routes.fetch(centralRuntimeRequest(
          `/session/${encodeURIComponent(request.sessionId)}/message`,
          {
            parts: [{
              type: "text",
              text: [
                "Channel-sourced input",
                `Source: ${request.channel}`,
                `External user: ${request.externalUserId}`,
                "Trust: external-untrusted",
                "",
                request.text,
              ].join("\n"),
            }],
          },
        ))),
      })
    },
    async abortSession(request: { sessionId: string }) {
      const res = await input.runtime.routes.fetch(centralRuntimeRequest(
        `/session/${encodeURIComponent(request.sessionId)}/abort`,
      ))
      if (!res.ok) return { ok: false, status: "failed", message: "Session cancel failed" }
      const body = await res.json().catch(() => undefined) as { ok?: boolean; status?: string; message?: string } | undefined
      return {
        ok: body?.ok === true,
        status: body?.status ?? "failed",
        ...(body?.message ? { message: body.message } : {}),
      }
    },
  }
  const sessionsByThread = new Map<string, SessionRef>()
  const pendingSessions = new Map<string, {
    generation: number
    promise: Promise<SessionRef>
  }>()
  const sessionCommits = new Map<string, {
    promise: Promise<void>
  }>()
  const sessionGenerations = new Map<string, number>()
  const resetBarriers = new Map<string, Promise<void>>()
  const resetFailures = new Map<string, unknown>()
  const sessions = {
    async resolve(envelope) {
      const generation = sessionGenerations.get(envelope.threadKey) ?? 0
      const existing = await this.get(envelope.threadKey)
      if ((sessionGenerations.get(envelope.threadKey) ?? 0) !== generation) {
        throw new ChannelSessionResolutionError("Channel session was reset while resolving. Send the message again.")
      }
      if (existing) return { ...existing, created: false }
      const pending = pendingSessions.get(envelope.threadKey)
      if (pending?.generation === generation) return { ...await pending.promise, created: false }
      const promise = (async () => {
        const result = await channelRuntime.createSession({
          title: `Channel: ${envelope.channel}`,
          channel: envelope.channel,
          threadKey: envelope.threadKey,
          externalUserId: envelope.externalUserId,
          ...(envelope.repo ? { workspaceId: `${envelope.repo.owner}/${envelope.repo.name}` } : {}),
        })
        const created = {
          sessionId: result.sessionId,
          threadKey: envelope.threadKey,
          channel: envelope.channel,
          ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
          ...(result.workspaceRef ? { workspaceRef: result.workspaceRef } : {}),
          ...(result.appUrl ? { appUrl: result.appUrl } : {}),
        }
        if ((sessionGenerations.get(envelope.threadKey) ?? 0) !== generation) {
          throw new ChannelSessionResolutionError("Channel session was reset before creation completed. Send the message again.")
        }
        const commit = (async () => {
          await input.services.projectionStore.record_channel_run_audit?.({
            sessionId: created.sessionId,
            channel: envelope.channel,
            externalUserId: envelope.externalUserId,
            threadKey: envelope.threadKey,
            workspaceId: created.workspaceId ?? null,
            cost: null,
          })
          try {
            input.services.telemetry.capture(`channel:${envelope.channel}:${envelope.externalUserId}`, "channel.session.created", {
              sessionId: created.sessionId,
              channel: envelope.channel,
              externalUserId: envelope.externalUserId,
              threadKey: envelope.threadKey,
              workspaceId: created.workspaceId ?? null,
              cost: null,
            })
          } catch {
            // Best-effort audit telemetry; session creation is already committed.
          }
        })()
        sessionCommits.set(envelope.threadKey, { promise: commit })
        try {
          await commit
          if ((sessionGenerations.get(envelope.threadKey) ?? 0) !== generation) {
            throw new ChannelSessionResolutionError("Channel session was reset while recording. Send the message again.")
          }
          sessionsByThread.set(envelope.threadKey, created)
          return created
        } finally {
          if (sessionCommits.get(envelope.threadKey)?.promise === commit) sessionCommits.delete(envelope.threadKey)
        }
      })()
      pendingSessions.set(envelope.threadKey, { generation, promise })
      try {
        const created = await promise
        return { ...created, created: true }
      } finally {
        if (pendingSessions.get(envelope.threadKey)?.promise === promise) pendingSessions.delete(envelope.threadKey)
      }
    },
    async get(threadKey) {
      await resetBarriers.get(threadKey)
      if (resetFailures.has(threadKey)) throw resetFailures.get(threadKey)
      const existing = sessionsByThread.get(threadKey)
      if (existing) return existing
      const readBinding = input.services.projectionStore.channel_thread_session
      if (!readBinding || !input.services.projectionStore.clear_channel_thread_session) return
      const sessionId = await readBinding({ threadKey })
      if (!sessionId) return
      const hit = await input.services.projectionStore.channel_run_audit?.({ sessionId })
      if (!hit) return
      return {
        sessionId: hit.sessionId,
        threadKey: hit.threadKey,
        channel: hit.channel as ChannelId,
        ...(hit.workspaceId ? { workspaceId: hit.workspaceId } : {}),
        appUrl: `/s/${encodeURIComponent(hit.sessionId)}`,
      }
    },
    async reset(threadKey) {
      sessionGenerations.set(threadKey, (sessionGenerations.get(threadKey) ?? 0) + 1)
      sessionsByThread.delete(threadKey)
      pendingSessions.delete(threadKey)
      const barrier = (async () => {
        const commit = sessionCommits.get(threadKey)
        const result = commit ? await Promise.allSettled([commit.promise]) : []
        await input.services.projectionStore.clear_channel_thread_session?.({ threadKey })
        if (result[0]?.status === "rejected") throw result[0].reason
      })()
      resetBarriers.set(threadKey, barrier)
      try {
        await barrier
        resetFailures.delete(threadKey)
      } catch (error) {
        resetFailures.set(threadKey, error)
        throw error
      } finally {
        if (resetBarriers.get(threadKey) === barrier) resetBarriers.delete(threadKey)
      }
    },
  } satisfies SessionResolver

  // DM/group access gate + per-sender rate limit (OpenClaw-hardened; see
  // channel-access-store.ts and @claxedo/channels core/access.ts). Owner ids
  // are pre-seeded via env so the box is reachable before anyone pairs.
  // CLAXEDO_CHANNEL_ALLOW_FROM: comma-separated "telegram:123,slack:U456".
  const allowFrom = (env.CLAXEDO_CHANNEL_ALLOW_FROM ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  const accessStore = input.accessStore ?? createSqliteChannelAccessStore()
  const bindings = input.identityBindingStore ?? createSqliteChannelIdentityBindingStore()
  // Default policy is LAYER-AWARE: in signed/hosted mode the account auth path
  // (authorize()) already gates who may act, so the DM gate defaults open;
  // in unsigned single-owner mode the pairing gate IS the defense, so it
  // defaults to pairing. An explicit CLAXEDO_CHANNEL_DM_POLICY always wins.
  const defaultDmPolicy = signedChannelAuthRequired(input.services) ? "open" : "pairing"
  // Groups are deny-by-default regardless of the DM posture above: a room is
  // full of people nobody approved individually, and the account-auth path can
  // only speak for senders it has a binding for. `parseGroupPolicy` defaults to
  // "allowlist"; an explicit CLAXEDO_CHANNEL_GROUP_POLICY still wins.
  const access = createChannelAccess({
    dmPolicy: parseDmPolicy(env.CLAXEDO_CHANNEL_DM_POLICY, defaultDmPolicy),
    groupPolicy: parseGroupPolicy(env.CLAXEDO_CHANNEL_GROUP_POLICY),
    groupEngagement: parseGroupEngagement(env.CLAXEDO_CHANNEL_GROUP_ENGAGEMENT),
    store: accessStore,
    bindings,
    ...(allowFrom.length ? { allowFrom } : {}),
  })
  // Per-sender inbound rate limit for ALLOWED senders (default 20/min).
  const rateLimit = Number(env.CLAXEDO_CHANNEL_RATE_LIMIT_PER_MIN ?? "20")
  const rateLimiter = createSlidingWindowRateLimiter({
    limit: Number.isFinite(rateLimit) && rateLimit > 0 ? rateLimit : 20,
    windowMs: 60_000,
  })
  const notificationRateLimiter = createSlidingWindowRateLimiter({
    limit: Number.isFinite(rateLimit) && rateLimit > 0 ? rateLimit : 20,
    windowMs: 60_000,
  })
  const onDenial = (envelope: InboundEnvelope, reason: ChannelDenialReason | "rate_limited") => {
    // Owner-visible audit only; never an amplifying reply to the sender.
    try {
      input.services.telemetry.capture(
        `channel:${envelope.channel}:${envelope.externalUserId}`,
        "channel.access.denied",
        { channel: envelope.channel, externalUserId: envelope.externalUserId, reason, chatType: envelope.chatType ?? "dm" },
      )
    } catch {
      // best-effort audit
    }
  }
  const canAdminister = (envelope: InboundEnvelope) => seedAdmin(allowFrom, envelope.channel, envelope.externalUserId)
  // Pre-dispatch daily budget: a per-sender turn ceiling (OpenClaw #42475 —
  // a guardrail between "approved" and "spent all night"). Counts on stable
  // (channel, sender, day) principals. 0/unset disables. True per-account $
  // budgets need cost accounting (not yet tracked) — this turn-count cap is
  // the honest MVP that bounds runaway usage today.
  const dailyBudget = Number(env.CLAXEDO_CHANNEL_DAILY_TURN_BUDGET ?? "0")
  const dedupStore = createProjectionDedupStore(input.services.projectionStore)
  const budget = dailyBudget > 0
    ? async (envelope: InboundEnvelope) => {
        const day = new Date((envelope.receivedAt ?? Date.now())).toISOString().slice(0, 10)
        const used = await dedupStore.countByChannelUserDay({
          channel: envelope.channel,
          externalUserId: envelope.externalUserId,
          day,
        }).catch(() => 0)
        if (used >= dailyBudget) {
          return { ok: false as const, message: `Daily limit reached (${dailyBudget} messages). Try again tomorrow.` }
        }
        return { ok: true as const }
      }
    : undefined
  const listSessions = async (query: { channel: string; externalUserId: string }) => {
    const audits = (await input.services.projectionStore.channel_run_audits?.({
      channel: query.channel,
      externalUserId: query.externalUserId,
    })) ?? []
    return audits.slice(0, 10).map((hit) => ({
      sessionId: hit.sessionId,
      appUrl: `/s/${encodeURIComponent(hit.sessionId)}`,
      ...(hit.workspaceId ? { title: `Workspace ${hit.workspaceId}` } : {}),
    }))
  }

  const core = createChannelCore({
    access,
    rateLimiter,
    onDenial,
    canAdminister,
    listSessions,
    ...(budget ? { budget } : {}),
    resetSession: (threadKey) => sessions.reset(threadKey),
    runtime: channelRuntime,
    dedup: dedupStore,
    sessions,
    approvals: createMemoryApprovalBridge({
      async onDecision(request, decision) {
        const channel = channelFromThreadKey(request.threadKey)
        const meta = await input.services.projectionStore.session_meta(request.sessionId)
        if (!channel && signedChannelAuthRequired(input.services)) {
          return { ok: false, message: "Unable to authorize approval without a channel thread." }
        }
        if (channel) {
          const auth = await authorizeChannelWorkspace({
            services: input.services,
            channel,
            externalUserId: decision.actorExternalUserId,
            threadKey: request.threadKey ?? `${channel}:unknown`,
            workspaceId: meta?.workspaceID,
            action: "write",
          }).catch((error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : "Unable to authorize channel approval.",
          }))
          if (auth.ok === false) return auth
        }
        const res = await input.runtime.routes.fetch(centralRuntimeRequest(
          `/session/${encodeURIComponent(request.sessionId)}/permissions/${encodeURIComponent(request.callId)}`,
          { response: decision.approved ? "once" : "deny" },
        ))
        if (res.ok) return { ok: true }
        return { ok: false, message: "Unable to record approval response." }
      },
    }),
    authorize: async (envelope, context) => await authorizeInbound({
      services: input.services,
      envelope,
      session: context?.existingSession,
      action: "write",
    }),
  })
  const registry = createChannelRegistry(env, { includeFake: input.includeFake === true })
  const dataMinimization = channelDataMinimization(env)
  const bot = input.chatBot
    ? Promise.resolve(input.chatBot)
    : registry.enabled.some((item) => item.channel !== "fake" && item.transport === "chat-sdk")
      ? createChatSdkChannelBot({
        registrations: registry.registrations,
        userName: env.CLAXEDO_CHANNEL_BOT_NAME ?? "claxedo",
        core,
        editInPlace: true,
        dataMinimization,
      })
      : undefined
  const whatsappBaileys = registry.enabled.some((item) => item.channel === "whatsapp" && item.transport === "baileys")
    ? Promise.resolve(input.whatsappBaileysSocket).then((socket) =>
        createWhatsAppBaileysTransport({
          core,
          socket: socket ?? createBaileysWhatsAppSocket({
            browserName: env.CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_BROWSER_NAME ?? "Claxedo",
            onQr: input.whatsappBaileysQrHandler,
          }),
          deviceId: env.CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_DEVICE_ID ?? "personal",
          botName: env.CLAXEDO_CHANNEL_BOT_NAME ?? "claxedo",
          authStateStore: createCredentialWhatsAppBaileysAuthStateStore({
            credentials: input.services.credentials,
            providerId: env.CLAXEDO_CHANNEL_WHATSAPP_BAILEYS_SECRET_ID,
          }),
          dataMinimization,
        }))
    : undefined

  const notifyOwner = async (request: {
    ownerUserId: string
    idempotencyKey: string
    text: string
    now?: number
  }) => {
    if (!bot) throw new Error("No outbound Chat SDK channel is configured")
    const recipients = (await bindings.listBoundForAccount(request.ownerUserId))
      .filter((recipient, index, all) => all.findIndex((candidate) =>
        candidate.channel === recipient.channel && candidate.externalUserId === recipient.externalUserId) === index)
    const enabled = new Set(registry.enabled
      .filter((item) => item.transport === "chat-sdk")
      .map((item) => item.channel))
    const audits = (await Promise.all(recipients.map((recipient) =>
      input.services.projectionStore.channel_run_audits?.({
        channel: recipient.channel,
        externalUserId: recipient.externalUserId,
      }) ?? Promise.resolve([]))))
      .flat()
      .filter((audit) => enabled.has(audit.channel as ChannelId))
      .sort((left, right) => right.createdAt - left.createdAt)
    const at = request.now ?? Date.now()
    let failure: unknown
    for (const audit of audits) {
      const channel = channelFromThreadKey(audit.threadKey)
      if (!channel) continue
      const admission = await access.gate({ channel, externalUserId: audit.externalUserId, chatType: "dm" })
      if (admission.admission !== "allow") continue
      const deliveryKey = `owner-notification:${request.idempotencyKey}`
      const claim = await input.services.projectionStore.claim_channel_delivery?.({
        channel,
        idempotencyKey: deliveryKey,
        externalUserId: audit.externalUserId,
        receivedAt: at,
        now: at,
        replayWindowMs: 24 * 60 * 60 * 1000,
        dailyCeiling: 1,
      })
      if (!claim?.ok) throw new Error(claim?.message ?? "Channel notification delivery log is unavailable")
      const receipt = {
        channel,
        threadKey: audit.threadKey,
        reference: `channel:${channel}:${audit.threadKey}`,
        duplicate: claim.duplicate,
      }
      if (claim.duplicate) return receipt
      if (!notificationRateLimiter.check(rateLimitKey(channel, audit.externalUserId), at).allowed) {
        await input.services.projectionStore.release_channel_delivery?.({ channel, idempotencyKey: deliveryKey })
        continue
      }
      try {
        const thread = (await bot).thread?.(audit.threadKey)
        if (!thread) throw new Error(`Outbound ${channel} thread delivery is unavailable`)
        await thread.post(sanitizeChannelText(request.text, dataMinimization))
        return receipt
      } catch (error) {
        failure = error
        await input.services.projectionStore.release_channel_delivery?.({ channel, idempotencyKey: deliveryKey })
      }
    }
    if (failure instanceof Error) throw failure
    throw new Error("The owner has no eligible outbound channel thread")
  }

  return {
    core,
    access,
    bindings,
    registry,
    ...(bot ? { bot } : {}),
    ...(whatsappBaileys ? { whatsappBaileys } : {}),
    notifyOwner,
    ingress: createChannelsIngress(core, {
      registrations: registry.registrations,
      ...(bot ? { bot } : {}),
      ...(whatsappBaileys ? { whatsappBaileys } : {}),
    }),
  }
}

export function mountControlPlaneChannels(app: HonoType, input: {
  services: ControlPlaneServices
  runtime: CentralRuntime
  env?: Record<string, string | undefined>
  includeFake?: boolean
  requireLoopbackForFake?: boolean
  whatsappBaileysSocket?: WhatsAppBaileysSocket | Promise<WhatsAppBaileysSocket | undefined>
  whatsappBaileysQrHandler?: (qr: string) => void
  channels?: ReturnType<typeof createControlPlaneChannels>
  authentication?: RequestAuthenticationAdapter
}) {
  if (input.requireLoopbackForFake !== false) {
    app.use("/api/channels/fake", async (c, next) => {
      if (!isLoopbackLocalRequest(c.req.raw)) {
        return c.json(errorBody("channels_fake_loopback_required", "Fake channels ingress requires loopback access"), 401)
      }
      return next()
    })
  }
  if ((input.env ?? process.env).CLAXEDO_CHANNEL_WHATSAPP_MODE === "personal") {
    app.use("/api/channels/whatsapp", async (c, next) => {
      if (!isLoopbackLocalRequest(c.req.raw)) {
        return c.json(errorBody("channels_whatsapp_personal_loopback_required", "Personal WhatsApp channel control requires loopback access"), 401)
      }
      return next()
    })
  }
  const channels = input.channels ?? createControlPlaneChannels(input)
  app.route("/api/channels", channels.ingress)

  // Bearer-gated pairing admin — the COLD-START approval path (no in-chat
  // admin seeded yet). Uses CLAXEDO_CHANNEL_ADMIN_TOKEN (falls back to
  // CLAXEDO_CREDENTIALS_TOKEN). Loopback is always allowed for local ops.
  const env = input.env ?? process.env
  const adminToken = (env.CLAXEDO_CHANNEL_ADMIN_TOKEN ?? env.CLAXEDO_CREDENTIALS_TOKEN)?.trim()
  const adminGate = async (c: { req: { raw: Request } }): Promise<boolean> => {
    if (isLoopbackLocalRequest(c.req.raw)) return true
    if (!adminToken) return false
    return c.req.raw.headers.get("authorization") === `Bearer ${adminToken}`
  }
  app.get("/api/channels/pairing", async (c) => {
    if (!(await adminGate(c))) return c.json(errorBody("channels_pairing_unauthorized", "Pairing admin requires a bearer token"), 401)
    const channel = c.req.query("channel") as ChannelId | undefined
    return c.json({ pending: await channels.access.listPending(channel) })
  })
  app.post("/api/channels/pairing/approve", async (c) => {
    if (!(await adminGate(c))) return c.json(errorBody("channels_pairing_unauthorized", "Pairing admin requires a bearer token"), 401)
    const body = await c.req.json().catch(() => ({})) as { code?: unknown }
    const code = typeof body.code === "string" ? body.code : undefined
    if (!code) return c.json(errorBody("channels_pairing_invalid", "Missing pairing code"), 400)
    const result = await channels.access.approve(code, "admin:route")
    if (!result.ok) return c.json(errorBody("channels_pairing_failed", result.message), 400)
    return c.json({ ok: true, channel: result.channel, externalUserId: result.externalUserId })
  })
  app.post("/api/channels/pairing/claim", async (c) => {
    const authority = input.services.authority
    if (!authority) return c.json(errorBody("channels_authority_unavailable", "Channel identity authority is unavailable"), 503)
    const authResult = await signedOrError(c.req.raw, {
      ...(input.authentication
        ? { authentication: input.authentication }
        : {
            authConfig: input.services.auth.config,
            ...(input.services.auth.verifier ? { verifier: input.services.auth.verifier } : {}),
          }),
      requireSigned: true,
    }, input.services)
    if ("error" in authResult) return c.json(authResult.error, authResult.status as 400 | 401 | 403 | 503)
    if (!authResult.auth) return c.json(errorBody("channels_pairing_unauthorized", "Signed account authentication is required"), 401)
    const body = await c.req.json().catch(() => ({})) as { code?: unknown }
    const code = typeof body.code === "string" ? body.code.trim() : ""
    if (!code) return c.json(errorBody("channels_pairing_invalid", "Missing pairing code"), 400)
    try {
      const result = await channels.access.approve(code, "authenticated-claim", async (identity) => {
        const binding = await authority.bindChannelIdentity(authResult.auth!, identity)
        return { accountId: binding.userId, boundBy: `actor:${binding.actorId}` }
      })
      if (!result.ok) return c.json(errorBody("channels_pairing_failed", result.message), 400)
      return c.json({ ok: true, channel: result.channel, externalUserId: result.externalUserId })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status)
      }
      throw error
    }
  })
  app.delete("/api/channels/identity", async (c) => {
    const authority = input.services.authority
    if (!authority) return c.json(errorBody("channels_authority_unavailable", "Channel identity authority is unavailable"), 503)
    const authResult = await signedOrError(c.req.raw, {
      ...(input.authentication
        ? { authentication: input.authentication }
        : {
            authConfig: input.services.auth.config,
            ...(input.services.auth.verifier ? { verifier: input.services.auth.verifier } : {}),
          }),
      requireSigned: true,
    }, input.services)
    if ("error" in authResult) return c.json(authResult.error, authResult.status as 400 | 401 | 403 | 503)
    if (!authResult.auth) return c.json(errorBody("channels_identity_unauthorized", "Signed account authentication is required"), 401)
    const body = await c.req.json().catch(() => ({})) as { channel?: unknown; externalUserId?: unknown }
    const channel = channelId(body.channel)
    if (!channel || typeof body.externalUserId !== "string") {
      return c.json(errorBody("channels_identity_invalid", "A supported channel and externalUserId are required"), 400)
    }
    try {
      const result = await authority.revokeChannelIdentity(authResult.auth, {
        channel,
        externalUserId: body.externalUserId,
      })
      if (result.revoked) {
        await channels.access.revoke(channel, body.externalUserId)
      }
      return c.json(result)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status)
      }
      throw error
    }
  })
  return channels
}
