import { renderSessionHandoff, sessionVariantForEffort, type SessionModelGroup, type SessionRef } from "@claxedo/agent-runtime-contract"
import type { AgentPluginExecutionSelection } from "../../agent-plugins/runtime/execution-selection"
import { sessionCreateRequest } from "../../workspace/http/session-create-request"
import type { Workspace } from "../../workspace/store/index"
import { configurationBlockers } from "./configuration-blockers"
import { originIds, type SessionOrigin } from "./origin-ids"
import { registeredSessionStates, type OriginSession, type RegisteredSession, type SessionLiveness, type SessionStateReading } from "./registered-sessions"
import {
  alreadySent,
  readMessages,
  readSessionConfiguration,
  runtimeRefusal,
  sessionTimes,
  untimedSession,
  type SessionTimes,
  type StoredSessionConfiguration,
} from "./session-runtime-answers"
import {
  sessionBridgeRefusal,
  unstartable,
  type SessionBridgeRefusal,
  type SessionBridgeResult,
  type SessionModelConfiguration,
  type SessionModelReference,
  type SessionStartBlocker,
} from "./session-start"

/** One workspace's runtime, already addressed and authorized by its host. */
export type SessionRuntimeTarget = {
  workspace: Workspace
  request(path: string, init?: RequestInit): Promise<Response>
}

/**
 * The workspace a start will run in, or why this host has none for it. A
 * refusal carries its own sentence because only the host knows what it looked
 * at — which workspaces a project has, and which of them it can reach.
 */
export type SessionTargetChoice = { target: SessionRuntimeTarget } | { detail: string }

/**
 * Where a cloud-placement root runs, the workspace whose start is still under
 * way, or the blocker that says why it does not run. The refusal names its own
 * blocker because the two answers are not the same refusal: a deployment with
 * no sandbox driver cannot offer this placement at all, while one that has a
 * driver and could not reach the project's source has an unavailable source.
 */
export type CloudTargetChoice =
  | { target: SessionRuntimeTarget }
  | { preparing: { workspaceId: string } }
  | { blocker: SessionStartBlocker }

/** The isolated workspace one origin's session runs in: one root per origin key. */
export type CloudRoot<Actor> = {
  actor: Actor
  origin: SessionOrigin
  projectId: string
  /** The organization the root is created in, whose sandbox provider key places it. */
  orgId: string
  displayName: string
  /**
   * The capability set this root runs. It is carried here rather than re-read
   * later because a configuration edited mid-start must not change what the
   * reserved one already resolved.
   */
  capabilities: AgentPluginExecutionSelection
}

export type SessionReservation =
  | { ok: true; headers: Record<string, string> }
  | SessionBridgeRefusal

/** What differs between the hosts that start origin sessions. */
export type SessionHost<Actor> = {
  /**
   * The workspace's runtime, or null when this host cannot reach one for it,
   * reached as `actor`: the person a start acts for, whose accounts a session
   * it creates spends, or who reads a previous transcript or removes an
   * unlinked session. A liveness reading acts for nobody.
   */
  target(workspaceId: string, actor: Actor | null): Promise<SessionRuntimeTarget | null>
  /**
   * Where a start with no workspace preference runs. Naming a workspace inside
   * a project is optional, so the host resolves the project's own workspace
   * instead of the start refusing for a choice nobody was asked to make.
   */
  projectTarget(projectId: string, starter: Actor): Promise<SessionTargetChoice>
  /**
   * The isolated workspace a cloud-placement start runs in, allocated to this
   * root and recovered by a retry of it. It answers as soon as the root's start
   * is under way rather than once its sandbox runs; the same start sent once it
   * runs finds the target. A host that names none cannot offer cloud placement.
   */
  cloudTarget?(root: CloudRoot<Actor>): Promise<CloudTargetChoice>
  /** Why this host would refuse to allocate the root, read without filing a row or starting anything. */
  cloudRefusal?(root: CloudRoot<Actor>): Promise<SessionStartBlocker | undefined>
  sessionMetas(sessionIds: readonly string[]): Promise<ReadonlyMap<string, { workspaceID?: string; archived?: number }>>
  /**
   * The rows these sessions' runtimes publish to this host's registry, for a
   * host whose runtimes publish every session they hold: liveness is read
   * from them and never from a runtime. Absent, each session's runtime is
   * asked.
   */
  registeredSessions?(sessionIds: readonly string[]): Promise<ReadonlyMap<string, RegisteredSession>>
  /**
   * Admission this host requires before a session may be created under an
   * origin. `operationId` is the origin and the configuration digest, so a
   * second configuration reaching the same session id collides here instead of
   * adopting the session the first one created. The actor comes with it because
   * a hosted reservation records the creator, and a session created for anyone
   * but the person who started it is one they cannot open.
   */
  reserve?(input: { actor: Actor; operationId: string; sessionId: string; workspaceId: string; title: string }): Promise<SessionReservation>
  /** Undo of `reserve`, for a session this host created under an origin nobody then recorded. */
  release?(input: { actor: Actor; operationId: string; sessionId: string; workspaceId: string; reason: string }): Promise<void>
  /**
   * Record the created session where this host's session lists read it from.
   * Absent on a host whose runtime registers every session it creates with
   * the authority `sessionMetas` reads: that registration is the record.
   */
  projectSessionMeta?(input: { sessionId: string; target: SessionRuntimeTarget; title: string; model: SessionModelReference; time: SessionTimes }): Promise<void>
  /** Remove what `projectSessionMeta` wrote, so an abandoned session leaves no row behind. */
  forgetSessionMeta?(sessionId: string): Promise<void>
}

/**
 * Liveness, and for a live session whether its origin's first message reached
 * it. A session nobody can read answers `unknown` rather than `pending`: the
 * two differ by whether anything may be sent on the strength of the answer.
 */
export async function sessionStates<Actor>(host: SessionHost<Actor>, origins: readonly OriginSession[]): Promise<SessionStateReading[]> {
  if (origins.length === 0) return []
  if (host.registeredSessions) return registeredSessionStates(origins, await host.registeredSessions(origins.map(({ session }) => session.sessionId)))
  const metas = await host.sessionMetas(origins.map(({ session }) => session.sessionId))
  return Promise.all(origins.map(async ({ origin, session }): Promise<SessionStateReading> => {
    const unread = (state: SessionLiveness): SessionStateReading => ({ session, state, handoff: "unknown" })
    const meta = metas.get(session.sessionId)
    if (!meta) return unread("deleted")
    if (meta.archived) return unread("archived")
    const target = await host.target(meta.workspaceID ?? session.workspaceId, null)
    if (!target) return unread("unavailable")
    const reachable = await target.request(`/session/${encodeURIComponent(session.sessionId)}`).catch(() => undefined)
    if (!reachable) return unread("unavailable")
    if (reachable.status === 404) return unread("deleted")
    if (!reachable.ok) return unread("unavailable")
    const sent = await alreadySent(target, session.sessionId, (await originIds(origin)).messageId)
    return { session, state: "live", handoff: sent === "unreadable" ? "unknown" : sent === "present" ? "sent" : "pending" }
  }))
}

/** Where a start that names a workspace, or only its project, runs on this host. */
export async function startTarget<Actor>(
  host: SessionHost<Actor>,
  input: { workspaceId: string | null; projectId: string; starter: Actor },
): Promise<SessionTargetChoice> {
  if (!input.workspaceId) return host.projectTarget(input.projectId, input.starter)
  const target = await host.target(input.workspaceId, input.starter)
  return target ? { target } : { detail: `Workspace ${input.workspaceId} is not reachable from this host` }
}

/** Why this host would refuse the cloud root, read without side effects, because a preview has none. */
export async function cloudRootRefusal<Actor>(host: SessionHost<Actor>, root: CloudRoot<Actor>): Promise<SessionStartBlocker | undefined> {
  if (!host.cloudTarget) {
    return { code: "placement_unsupported", detail: "This host starts sessions in a project's own workspace; an isolated cloud workspace is not available here" }
  }
  return host.cloudRefusal?.(root)
}

/** A previous session's conversation, rendered by the runtime's own renderer. */
export type SessionHandoffTranscript = { session: SessionRef; transcript: string }

/**
 * Whether this reader may still read the previous session's transcript. It is
 * asked at the read itself: resolving the session's workspace is an await, and
 * a grant withdrawn while it runs has to stop the read rather than be noticed
 * after it.
 */
export type TranscriptGrant = () => Promise<boolean>

/**
 * The previous session's conversation, or null when its runtime cannot be
 * reached or holds nothing to carry over. A refused grant is a refusal, never
 * a quiet null, so a caller cannot read it as a session with nothing to say.
 */
export async function readHandoffTranscript<Actor>(
  host: SessionHost<Actor>,
  input: { fallback: SessionRuntimeTarget | null; previous: SessionRef | null; authorize: TranscriptGrant; reader: Actor },
): Promise<{ ok: true; handoff: SessionHandoffTranscript | null } | SessionBridgeRefusal> {
  const { previous } = input
  if (!previous) return { ok: true, handoff: null }
  const target = previous.workspaceId === input.fallback?.workspace.id ? input.fallback : await host.target(previous.workspaceId, input.reader)
  if (!target) return { ok: true, handoff: null }
  if (!(await input.authorize())) return sessionBridgeRefusal("forbidden", `No access to session ${previous.sessionId}, so its transcript was not read`)
  const [messages, stored] = await Promise.all([readMessages(target, previous.sessionId), readSessionConfiguration(target, previous.sessionId)])
  if (!messages?.length || !stored) return { ok: true, handoff: null }
  return { ok: true, handoff: { session: previous, transcript: renderSessionHandoff(messages, stored.harness) } }
}

/**
 * The cloud root a start runs in, allocated now. A root whose start is still
 * under way answers `preparing`; the harness is asked about the model only
 * once the root runs, because only a running runtime can answer.
 */
export async function allocateCloudRoot<Actor>(
  host: SessionHost<Actor>,
  root: CloudRoot<Actor>,
  configuration: SessionModelConfiguration,
): Promise<{ target: SessionRuntimeTarget } | { ok: true; preparing: { workspaceId: string } } | SessionBridgeRefusal> {
  if (!host.cloudTarget) return unstartable([])
  const choice = await host.cloudTarget(root)
  if ("blocker" in choice) return unstartable([choice.blocker])
  if ("preparing" in choice) return { ok: true, preparing: choice.preparing }
  const blockers = await configurationBlockers(choice.target, configuration)
  return blockers.length === 0 ? { target: choice.target } : unstartable(blockers)
}

const creating = new Map<string, Promise<unknown>>()

/**
 * One creator per origin inside this process.
 *
 * The session id is derived from the origin, so two concurrent starts would
 * otherwise both read it as absent and create it — the second with whichever
 * configuration it resolved, under the id the first one is already using. A
 * host with a managed reservation refuses the second before it gets here; an
 * unsigned local host has no such table, and one process is the whole of it.
 */
async function perOrigin<T>(origin: string, work: () => Promise<T>): Promise<T> {
  const queued = (creating.get(origin) ?? Promise.resolve()).then(work, work)
  const tail = queued.then(
    () => undefined,
    () => undefined,
  )
  creating.set(origin, tail)
  void tail.then(() => {
    if (creating.get(origin) === tail) creating.delete(origin)
  })
  return queued
}

/** What a start creates once its destination resolved: one session per origin, under the configuration the start's digest names. */
export type OriginSessionCreate<Actor> = {
  actor: Actor
  origin: SessionOrigin
  target: SessionRuntimeTarget
  title: string
  configuration: SessionModelConfiguration
  group?: SessionModelGroup
  instructions: string
  /** Names the reservation with the origin, so a second configuration claiming the same session collides instead of adopting it. */
  configurationDigest: string
}

/**
 * The origin's session, created now or taken back over: a session this origin
 * already created is answered only while it runs the same configuration and
 * the host's session lists know about it.
 */
export async function createOriginSession<Actor>(host: SessionHost<Actor>, input: OriginSessionCreate<Actor>): Promise<SessionBridgeResult<{ session: SessionRef }>> {
  const { sessionId } = await originIds(input.origin)
  const { target } = input
  const operationId = `${input.origin.key}:${input.configurationDigest}`
  const held = await perOrigin(input.origin.key, async (): Promise<{ ok: true } | SessionBridgeRefusal> => {
    const reserved = await host.reserve?.({ actor: input.actor, operationId, sessionId, workspaceId: target.workspace.id, title: input.title })
    if (reserved && !reserved.ok) return reserved

    const existing = await target.request(`/session/${encodeURIComponent(sessionId)}`).catch(() => undefined)
    if (!existing) return sessionBridgeRefusal("unsupported", "The workspace runtime is unreachable")
    if (existing.status === 200) return recoverSession(host, existing, sessionId, input)

    const create = sessionCreateRequest({
      id: sessionId,
      title: input.title,
      model: input.configuration.model,
      harness: input.configuration.harness,
      ...(input.group ? { group: input.group } : {}),
      instructions: input.instructions,
      ...sessionVariantForEffort(input.configuration.effort ?? undefined),
    })
    const created = await target.request(create.path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(reserved?.ok ? reserved.headers : {}) },
      body: create.body,
    })
    if (!created.ok) {
      // A runtime that refuses because the id is taken has the session another
      // start created, which is the same situation as finding it above: adopt
      // it only if it is running this configuration.
      const collided = await target.request(`/session/${encodeURIComponent(sessionId)}`).catch(() => undefined)
      if (collided?.status === 200) return recoverSession(host, collided, sessionId, input)
      return { ok: false, error: await runtimeRefusal("create this session", created) }
    }
    const time = await sessionTimes(created)
    if (!time) return untimedSession(sessionId)
    await host.projectSessionMeta?.({ sessionId, target, title: input.title, model: input.configuration.model, time })
    return { ok: true }
  })
  if (!held.ok) return held
  return { ok: true, session: { sessionId, workspaceId: target.workspace.id } }
}

/** One part of a first message, as the composer sends it: text, then the files it illustrates. */
export type SessionPromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename: string; url: string }

/**
 * The origin's first message, sent to the session its owner recorded. The
 * message id comes from the origin and the history is read first, so a
 * handoff retried after a crash sends once, and one retried after it landed
 * sends nothing.
 */
export async function handOffToSession<Actor>(
  host: SessionHost<Actor>,
  input: { actor: Actor; origin: SessionOrigin; session: SessionRef; parts: readonly SessionPromptPart[]; runtime?: SessionRuntimeTarget },
): Promise<SessionBridgeResult<{ sent: boolean }>> {
  const target = input.runtime ?? await host.target(input.session.workspaceId, input.actor)
  if (!target) return sessionBridgeRefusal("unsupported", `Session ${input.session.sessionId} is not reachable from this host`)
  const { messageId } = await originIds(input.origin)
  const sent = await alreadySent(target, input.session.sessionId, messageId)
  if (sent === "unreadable") {
    return sessionBridgeRefusal("conflict", "The workspace runtime would not say whether this session already has its first message; it was not sent again")
  }
  if (sent === "present") return { ok: true, sent: false }
  const prompt = await target.request(`/session/${encodeURIComponent(input.session.sessionId)}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageID: messageId, parts: input.parts }),
  })
  if (!prompt.ok) return { ok: false, error: await runtimeRefusal("send the first message", prompt) }
  return { ok: true, sent: true }
}

/**
 * A session this origin created and nobody recorded, removed so the next
 * start may have the origin back.
 *
 * The history is read first for the same reason the handoff reads it: this
 * origin's first message on the session means the session was handed over and
 * is the person's, whatever the caller believes. The reservation is released
 * after the delete, so a host whose delete failed still holds the origin
 * rather than freeing an id its session still answers.
 */
export async function abandonOriginSession<Actor>(
  host: SessionHost<Actor>,
  input: { actor: Actor; origin: SessionOrigin; session: SessionRef; configurationDigest: string; reason: string; runtime?: SessionRuntimeTarget },
): Promise<SessionBridgeResult<{ removed: boolean }>> {
  const target = input.runtime ?? await host.target(input.session.workspaceId, input.actor)
  if (!target) return sessionBridgeRefusal("unsupported", `Session ${input.session.sessionId} is not reachable from this host`)
  const { sessionId } = input.session
  const sent = await alreadySent(target, sessionId, (await originIds(input.origin)).messageId)
  if (sent === "present") return { ok: true, removed: false }
  if (sent === "unreadable") {
    return sessionBridgeRefusal("conflict", `The workspace runtime would not say whether session ${sessionId} already has its first message; it was kept`)
  }
  const removed = await target.request(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  if (!removed.ok) return { ok: false, error: await runtimeRefusal("delete this session", removed) }
  await host.forgetSessionMeta?.(sessionId)
  await host.release?.({
    actor: input.actor,
    operationId: `${input.origin.key}:${input.configurationDigest}`,
    sessionId,
    workspaceId: target.workspace.id,
    reason: input.reason,
  })
  return { ok: true, removed: true }
}

/**
 * A session this origin already created, taken back over. It must be running
 * the configuration this start resolved, and the session lists this host reads
 * liveness from must know about it.
 */
async function recoverSession<Actor>(
  host: SessionHost<Actor>,
  session: Response,
  sessionId: string,
  input: OriginSessionCreate<Actor>,
): Promise<{ ok: true } | SessionBridgeRefusal> {
  const stored = await readSessionConfiguration(input.target, sessionId)
  if (!stored) {
    return sessionBridgeRefusal("conflict", `The workspace runtime would not say what session ${sessionId} is configured to run, so this start did not adopt it`)
  }
  if (!sameConfiguration(stored, input)) {
    return sessionBridgeRefusal("conflict", `Session ${sessionId} is already running another configuration for this origin; start a new one instead`)
  }
  // Metadata is written by the create this start skipped. Left missing, the
  // session lists read the origin's session as deleted and admit another one
  // while this session is still running.
  const metas = await host.sessionMetas([sessionId])
  if (!metas.has(sessionId)) {
    if (!host.projectSessionMeta) {
      return sessionBridgeRefusal("conflict", `Session ${sessionId} exists but its registration with this control plane is unresolved, so this start did not adopt it`)
    }
    const time = await sessionTimes(session)
    if (!time) return untimedSession(sessionId)
    await host.projectSessionMeta({ sessionId, target: input.target, title: input.title, model: input.configuration.model, time })
  }
  return { ok: true }
}

function sameConfiguration(stored: StoredSessionConfiguration, input: OriginSessionCreate<unknown>): boolean {
  return stored.harness.id === input.configuration.harness.id
    && stored.harness.access === input.configuration.harness.access
    && stored.model?.providerID === input.configuration.model.providerID
    && stored.model?.modelID === input.configuration.model.modelID
    && stored.effort === (input.configuration.effort ?? null)
    && stored.instructions === input.instructions
}
