import type { D1Database } from "@cloudflare/workers-types"
import { AGENT_HARNESS_DEFINITIONS, cloudHarnessHost, type SessionRef } from "@claxedo/agent-runtime-contract"
import { base64EncodeBytes, sha256Hex } from "@claxedo/helpers/crypto"
import { asRecord } from "@claxedo/helpers/guards"
import { utf8ByteLength } from "@claxedo/helpers/string"
import {
  PLUGIN_SESSION_LIMITS,
  type PluginCaller,
  type PluginPlatformAnswer,
  type PluginSessionHarness,
  type PluginSessionOrigin,
  type PluginSessionPlacement,
  type PluginSessionState,
} from "@claxedo/plugin-api/backend"
import { canonicalJsonText } from "@claxedo/plugin-api/release"
import { answeredCall, refusedCall, type PluginHostCall, type PluginScope } from "@claxedo/plugin-runtime"
import { cloudHarnessRefusal, configurationBlockers } from "@claxedo/server-core/plugin-platform/sessions/configuration-blockers"
import type { SessionOrigin } from "@claxedo/server-core/plugin-platform/sessions/origin-ids"
import {
  abandonOriginSession,
  allocateCloudRoot,
  cloudRootRefusal,
  createOriginSession,
  handOffToSession,
  readHandoffTranscript,
  sessionStates,
  startTarget,
  type CloudRoot,
  type SessionHandoffTranscript,
  type SessionHost,
  type SessionPromptPart,
  type SessionRuntimeTarget,
} from "@claxedo/server-core/plugin-platform/sessions/session-bridge-core"
import { unstartable, type SessionBridgeFailure, type SessionBridgeFailureCode, type SessionStartBlocker } from "@claxedo/server-core/plugin-platform/sessions/session-start"
import { sessionHarnessQuery } from "@claxedo/server-core/workspace/http/session-create-request"
import { may } from "../../authority/adapters/d1/authorization"
import type { HostedSessionPorts } from "./compose"
import { createHostedSessionHost } from "./host"
import { pluginSessionOrigins, type RecordedPluginSession } from "./origins"

export type PluginSessionCall = Extract<PluginHostCall, { name: `sessions.${string}` }>

/** One of the plugin's blobs, as an attachment reads it. */
export type PluginSessionBlob = Readonly<{ bytes: Uint8Array; contentType?: string }>

export type HostedPluginSessionsInput = HostedSessionPorts &
  Readonly<{
    database: D1Database
    /** The plugin's own blob under `key`, or undefined when it stored none. */
    blob(scope: PluginScope, key: string): Promise<PluginSessionBlob | undefined>
    now?: () => number
  }>

/** The person an app plugin's call acts for, by canonical actor in the plugin's organization. */
type PluginSessionActor = Readonly<{ orgId: string; userId: string; actorId: string }>

/** The platform namespace an app plugin's session and message ids are minted under. */
const PLUGIN_SESSION_NAMESPACE = "plugin"

const TRANSCRIPT_HEADING = "## The previous session"

const FAILURE_STATUS: Readonly<Record<SessionBridgeFailureCode, number>> = { invalid_input: 400, forbidden: 403, conflict: 409, unsupported: 422, rate_limited: 429 }

function sessionRefusal(error: SessionBridgeFailure): PluginPlatformAnswer {
  return refusedCall(FAILURE_STATUS[error.code], `plugin_session_${error.code}`, error.message)
}

/** The organization, plugin and the plugin's own origin, so no two plugins' keys meet in the namespace every root and reservation is named in. */
function pluginSessionOrigin(scope: PluginScope, origin: PluginSessionOrigin): SessionOrigin {
  const key = ["app-plugin.v1", scope.orgId, scope.pluginId, origin.scope, origin.key].map(encodeURIComponent).join(":")
  return { namespace: PLUGIN_SESSION_NAMESPACE, key }
}

const sameSession = (left: SessionRef, right: SessionRef) => left.sessionId === right.sessionId && left.workspaceId === right.workspaceId

/** The newest part of `text` that fits `bytes`, cut on a character boundary. */
function utf8Tail(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= bytes) return text
  let start = encoded.length - bytes
  while (start < encoded.length && (encoded[start] ?? 0) >= 0x80 && (encoded[start] ?? 0) < 0xc0) start += 1
  return new TextDecoder().decode(encoded.subarray(start))
}

/**
 * The plugin's instructions, then the previous session's transcript in the
 * room the runtime's instruction cap leaves, its newest turns kept.
 */
function composeInstructions(own: string, transcript: string | undefined): string {
  const head = own.trim()
  const previous = transcript?.trim()
  if (!previous) return head
  const room = PLUGIN_SESSION_LIMITS.instructionsBytes - utf8ByteLength(head) - utf8ByteLength(TRANSCRIPT_HEADING) - 8
  if (room <= 0) return head
  return [...(head ? [head] : []), TRANSCRIPT_HEADING, utf8Tail(previous, room)].join("\n\n")
}

type StartCall = Extract<PluginSessionCall, { name: "sessions.preview" | "sessions.start" }>

/** What a preview resolved, and what a start with its digest then runs. */
type ResolvedStart = {
  origin: SessionOrigin
  recorded: RecordedPluginSession | undefined
  target: SessionRuntimeTarget | null
  root: CloudRoot<PluginSessionActor> | null
  blockers: SessionStartBlocker[]
  instructions: string
  continued: SessionHandoffTranscript | null
  /** Names the reservation; the transcript is outside it, so a start retried after the previous session moved still recovers its own. */
  configurationDigest: string
  digest: string
}

/**
 * The hosted platform's session calls for app plugins: a start runs as the
 * caller, in a project they may write, through the session host Tasks starts
 * through too, and its origin is recorded in `plugin_session_origins`, which
 * every later handoff, abandonment and state reading is answered from.
 */
export function hostedPluginSessions(input: HostedPluginSessionsInput) {
  const { database } = input
  const now = input.now ?? Date.now
  const origins = pluginSessionOrigins(database)
  const host: SessionHost<PluginSessionActor> = createHostedSessionHost<PluginSessionActor>({
    ...input,
    owner: (actor) => actor,
    principal: async (actor) => ({ principalKind: "user", actorId: actor.actorId, actorKind: "human" }),
  })

  async function actorOf(scope: PluginScope, caller: PluginCaller | undefined): Promise<PluginSessionActor | undefined> {
    if (!caller?.userId) return undefined
    const row = await database
      .prepare(`
        select a.actor_id from actors a join users u on u.user_id = a.user_id and u.state = 'active'
        where a.user_id = ? and a.kind = 'human' and a.state = 'active'
      `)
      .bind(caller.userId)
      .first<{ actor_id: string }>()
    return row ? { orgId: scope.orgId, userId: caller.userId, actorId: row.actor_id } : undefined
  }

  async function mayOpen(scope: PluginScope, actor: PluginSessionActor, session: SessionRef): Promise<boolean> {
    const inOrganization = await database
      .prepare("select 1 from sessions where session_id = ? and workspace_id = ? and org_id = ? and deleted_at is null")
      .bind(session.sessionId, session.workspaceId, scope.orgId)
      .first()
    return inOrganization !== null && (await may(database, { userId: actor.userId }, "read", { kind: "session", ...session }))
  }

  const mayUseProject = (scope: PluginScope, actor: PluginSessionActor, projectId: string, access: "read" | "write") =>
    may(database, { userId: actor.userId }, access, { kind: "project", projectId, orgId: scope.orgId })

  async function resolve(scope: PluginScope, actor: PluginSessionActor, call: StartCall): Promise<ResolvedStart | PluginPlatformAnswer> {
    if (!(await mayUseProject(scope, actor, call.projectId, "write"))) return refusedCall(403, "plugin_project_forbidden", "The caller may not start sessions in that project")
    const origin = pluginSessionOrigin(scope, call.origin)
    const recorded = await origins.read(scope, call.origin)
    if (recorded && recorded.placement !== call.placement) {
      return refusedCall(409, "plugin_session_conflict", `This origin already started a ${recorded.placement} session`)
    }
    const blockers: SessionStartBlocker[] = []
    let target: SessionRuntimeTarget | null = null
    let root: CloudRoot<PluginSessionActor> | null = null
    if (call.placement === "cloud") {
      root = {
        actor,
        origin,
        projectId: call.projectId,
        orgId: scope.orgId,
        displayName: call.title ?? scope.pluginId,
        capabilities: call.selection ?? { plugins: [], skills: [] },
      }
      const harness = cloudHarnessRefusal(call.configuration.harness)
      const refused = harness ? { code: "harness_unavailable" as const, detail: harness } : await cloudRootRefusal(host, root)
      if (refused) blockers.push(refused)
    } else if (recorded) {
      target = await host.target(recorded.session.workspaceId, actor)
      if (!target) blockers.push({ code: "source_unavailable", detail: "The workspace this origin's session runs in cannot be reached from here" })
    } else {
      const choice = await startTarget(host, { workspaceId: null, projectId: call.projectId, starter: actor })
      if ("target" in choice) target = choice.target
      else blockers.push({ code: "source_unavailable", detail: choice.detail })
    }

    let continued: SessionHandoffTranscript | null = null
    const previous = call.continueFrom
    if (blockers.length === 0 && previous) {
      const read = await readHandoffTranscript(host, { fallback: target, previous, authorize: () => mayOpen(scope, actor, previous), reader: actor })
      if (!read.ok) return sessionRefusal(read.error)
      continued = read.handoff
    }
    if (target && blockers.length === 0) blockers.push(...(await configurationBlockers(target, call.configuration)))

    const instructions = composeInstructions(call.instructions ?? "", continued?.transcript)
    const configurationDigest = await sha256Hex(
      canonicalJsonText({
        origin: origin.key,
        placement: call.placement,
        configuration: call.configuration,
        instructions: call.instructions ?? "",
        selection: call.selection ?? null,
        title: call.title ?? null,
      }),
    )
    const digest = await sha256Hex(
      canonicalJsonText({ configurationDigest, projectId: call.projectId, workspaceId: target?.workspace.id ?? null, instructions, continuedFrom: continued?.session ?? null }),
    )
    return { origin, recorded, target, root, blockers, instructions, continued, configurationDigest, digest }
  }

  /** A member-driven session's agent delegates through `subagent_spawn`; only the owner's own session may start one detached. */
  function agentStartRefusal(caller: PluginCaller | undefined): PluginPlatformAnswer | undefined {
    if (caller?.origin !== "agent" || caller.ownerDriven === true) return undefined
    return refusedCall(403, "plugin_session_start_refused", "A session another member drives cannot start a session of its own")
  }

  async function start(scope: PluginScope, actor: PluginSessionActor, call: Extract<PluginSessionCall, { name: "sessions.start" }>): Promise<PluginPlatformAnswer> {
    const resolved = await resolve(scope, actor, call)
    if (!("digest" in resolved)) return resolved
    if (resolved.blockers.length > 0) return sessionRefusal(unstartable(resolved.blockers).error)
    if (call.digest !== resolved.digest) return refusedCall(409, "plugin_session_digest_stale", "The previewed session is no longer the one this start would run")
    let target = resolved.target
    if (!target) {
      if (!resolved.root) return sessionRefusal(unstartable([]).error)
      const allocated = await allocateCloudRoot(host, resolved.root, call.configuration)
      if ("preparing" in allocated) return answeredCall({ preparing: allocated.preparing })
      if (!("target" in allocated)) return sessionRefusal(allocated.error)
      target = allocated.target
    }
    const created = await createOriginSession(host, {
      actor,
      origin: resolved.origin,
      target,
      title: call.title ?? scope.pluginId,
      configuration: call.configuration,
      instructions: resolved.instructions,
      configurationDigest: resolved.configurationDigest,
    })
    if (!created.ok) return sessionRefusal(created.error)
    await origins.record(scope, { origin: call.origin, session: created.session, placement: call.placement, configurationDigest: resolved.configurationDigest }, now())
    return answeredCall({ session: created.session, ...(resolved.continued ? { continuedFrom: resolved.continued.session } : {}) })
  }

  /** The origin's recorded session, if it is the one the call names. */
  async function recordedFor(scope: PluginScope, origin: PluginSessionOrigin, session: SessionRef) {
    const recorded = await origins.read(scope, origin)
    return recorded && sameSession(recorded.session, session) ? recorded : undefined
  }

  async function attachmentParts(scope: PluginScope, attachments: Extract<PluginSessionCall, { name: "sessions.handoff" }>["attachments"]): Promise<SessionPromptPart[] | PluginPlatformAnswer> {
    const parts: SessionPromptPart[] = []
    const types: readonly string[] = PLUGIN_SESSION_LIMITS.attachmentTypes
    for (const attachment of attachments ?? []) {
      const blob = await input.blob(scope, attachment.key)
      if (!blob) return refusedCall(404, "plugin_blob_not_found", `The plugin stored no blob ${attachment.key}`)
      if (!blob.contentType || !types.includes(blob.contentType)) {
        return refusedCall(415, "plugin_session_attachment_type", `Blob ${attachment.key} is not a PNG, JPEG, GIF or WebP image`)
      }
      if (blob.bytes.byteLength > PLUGIN_SESSION_LIMITS.attachmentBytes) {
        return refusedCall(413, "plugin_session_attachment_too_large", `Blob ${attachment.key} is over the ${PLUGIN_SESSION_LIMITS.attachmentBytes} bytes a session attachment may hold`)
      }
      parts.push({
        type: "file",
        mime: blob.contentType,
        filename: attachment.filename ?? attachment.key.split("/").at(-1) ?? attachment.key,
        url: `data:${blob.contentType};base64,${base64EncodeBytes(blob.bytes)}`,
      })
    }
    return parts
  }

  async function harnesses(scope: PluginScope, actor: PluginSessionActor, projectId: string, placement: PluginSessionPlacement): Promise<PluginPlatformAnswer> {
    if (!(await mayUseProject(scope, actor, projectId, "read"))) return refusedCall(403, "plugin_project_forbidden", "The caller may not read that project")
    const native = AGENT_HARNESS_DEFINITIONS.filter((definition) => definition.access === "native")
    if (placement === "cloud") {
      if (!input.runtimeClient.sandboxManager) return answeredCall([])
      return answeredCall(native.filter((definition) => cloudHarnessHost(definition.id) === "workspace-runtime").map((definition): PluginSessionHarness => ({ id: definition.id, access: "native", label: definition.label, models: [] })))
    }
    const choice = await startTarget(host, { workspaceId: null, projectId, starter: actor })
    if (!("target" in choice)) return answeredCall([])
    const { target } = choice
    const offered = await Promise.all(native.map(async (definition): Promise<PluginSessionHarness | undefined> => {
      const harness = { id: definition.id, access: "native" as const }
      const response = await target.request(`/session/capabilities?${sessionHarnessQuery(harness)}`).catch(() => undefined)
      if (!response?.ok) return undefined
      const selection = asRecord(asRecord(await response.json().catch(() => undefined))?.modelSelection)
      const models = (Array.isArray(selection?.models) ? selection.models : []).flatMap((model) => {
        const entry = asRecord(model)
        const providerID = typeof entry?.providerId === "string" ? entry.providerId : undefined
        const modelID = typeof entry?.modelId === "string" ? entry.modelId : undefined
        if (!providerID || !modelID) return []
        return [{ providerID, modelID, ...(typeof entry?.name === "string" ? { name: entry.name } : {}) }]
      })
      return { ...harness, label: definition.label, models }
    }))
    return answeredCall(offered.filter((harness): harness is PluginSessionHarness => harness !== undefined))
  }

  return async (call: PluginSessionCall, scope: PluginScope, caller: PluginCaller | undefined): Promise<PluginPlatformAnswer> => {
    if (call.name === "sessions.state") {
      const recorded = await origins.readMany(scope, call.origins)
      const readings = await sessionStates(host, recorded.map((entry) => ({ origin: pluginSessionOrigin(scope, entry.origin), session: entry.session })))
      return answeredCall(recorded.map((entry, index): PluginSessionState => ({
        origin: entry.origin,
        session: entry.session,
        state: readings[index]?.state ?? "unavailable",
        handoff: readings[index]?.handoff ?? "unknown",
      })))
    }
    const actor = await actorOf(scope, caller)
    if (!actor) return refusedCall(403, "plugin_caller_not_a_person", `${call.name} acts as a person, and this caller is no active person`)
    switch (call.name) {
      case "sessions.harnesses":
        return harnesses(scope, actor, call.projectId, call.placement)
      case "sessions.preview": {
        const refused = agentStartRefusal(caller)
        if (refused) return refused
        const resolved = await resolve(scope, actor, call)
        if (!("digest" in resolved)) return resolved
        return answeredCall({ digest: resolved.digest, blockers: resolved.blockers })
      }
      case "sessions.start":
        return agentStartRefusal(caller) ?? start(scope, actor, call)
      case "sessions.handoff": {
        const recorded = await recordedFor(scope, call.origin, call.session)
        if (!recorded) return refusedCall(404, "plugin_session_origin_unknown", "This plugin's origin started no such session")
        const files = await attachmentParts(scope, call.attachments)
        if (!Array.isArray(files)) return files
        const handed = await handOffToSession(host, {
          actor,
          origin: pluginSessionOrigin(scope, call.origin),
          session: recorded.session,
          parts: [{ type: "text", text: call.text }, ...files],
        })
        return handed.ok ? answeredCall({ sent: handed.sent }) : sessionRefusal(handed.error)
      }
      case "sessions.abandon": {
        const recorded = await recordedFor(scope, call.origin, call.session)
        if (!recorded) return refusedCall(404, "plugin_session_origin_unknown", "This plugin's origin started no such session")
        const abandoned = await abandonOriginSession(host, {
          actor,
          origin: pluginSessionOrigin(scope, call.origin),
          session: recorded.session,
          configurationDigest: recorded.configurationDigest,
          reason: "The plugin abandoned the session its origin started",
        })
        if (!abandoned.ok) return sessionRefusal(abandoned.error)
        if (abandoned.removed) await origins.forget(scope, call.origin, recorded.session)
        return answeredCall({ removed: abandoned.removed })
      }
      case "sessions.authorizeOpen":
        return answeredCall(await mayOpen(scope, actor, call.session))
      default: {
        const unanswered: never = call
        throw new Error(`the hosted platform answers no session call ${JSON.stringify(unanswered)}`)
      }
    }
  }
}

export type HostedPluginSessions = ReturnType<typeof hostedPluginSessions>
