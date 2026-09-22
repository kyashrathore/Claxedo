import { createHmac, randomUUID } from "crypto"
import { createSubagentAdmissionBoundary, type SubagentAdmissionStore, type SubagentObservation } from "@claxedo/agent-sdk-runtime"
import type { AgentMessage, AgentSession, RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import type { SubagentStatus, SubagentWake } from "@claxedo/agent-event-runtime"
import { asRecord } from "@claxedo/helpers/guards"
import type { CompatEnvelope } from "../compat-events"
import type { RuntimeEventEnvelopeInput } from "../runtime-event-hub"
import type { SessionPromptBody } from "../session/service"
import type { SessionTurnOrigin } from "../session-access-policy"
import { num, str } from "../json-value"

/** `providerKind` of a subagent row whose child is a session this runtime created itself. */
export const HOST_CHILD_PROVIDER_KIND = "claxedo"
export const MAX_ACTIVE_CHILDREN_PER_PARENT = 4
const ACTIVE_CHILD_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "paused"])
const TERMINAL_CHILD_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "killed", "interrupted"])
const WAKE_SUMMARY_MAX_CHARS = 8_000

export type HostChildRow = {
  parentSessionId: string
  subagentKey: string
  childSessionId: string
  status?: string
  label?: string
  subagentType?: string
  attention?: number
  wake?: SubagentWake
}

export type ChildWakeAuthor = { id: string; name: string; kind: "agent" }

export type PendingChildWake = { parentSessionId: string; childSessionId: string; directory: string }

/**
 * Where the identity behind a child outlives the request that created it.
 *
 * A completion wake is a turn on the parent, and the authority decides a turn
 * about an actor. The request that created the child is long gone by then, and
 * after a restart so is every in-process trace of it, so the actor it verified
 * is read back from here instead. A host without this port drives wakes with
 * no identity, which a managed runtime refuses.
 */
export type ChildOriginStore = {
  record(parentSessionId: string, subagentKey: string, origin: SessionTurnOrigin): void | Promise<void>
  read(parentSessionId: string, subagentKey: string): SessionTurnOrigin | undefined | Promise<SessionTurnOrigin | undefined>
}

export type ChildSessionHostInput = {
  admission: SubagentAdmissionStore
  /** Keyed material for idempotent child ids; must survive restarts (S12). */
  secret: () => string
  origins?: ChildOriginStore
  listSubagents: (parentSessionId: string, directory: string) => Promise<unknown[]> | unknown[]
  pendingWakes: () => Promise<PendingChildWake[]> | PendingChildWake[]
  getSession: (sessionId: string, directory: string) => Promise<AgentSession | null | undefined> | AgentSession | null | undefined
  getMessages: (sessionId: string, directory: string) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined
  publishRuntime: (event: RuntimeEventEnvelopeInput) => void
  subscribeGlobal?: (fn: (event: CompatEnvelope) => void) => () => void
  /**
   * Starts the parent turn that carries a child's summary. Resolves once the
   * turn is admitted (`started`) or refused because the parent is mid-turn
   * (`busy`); the turn itself runs on, and `onSettled` fires when it ends.
   */
  startTurn: (input: {
    parentSessionId: string
    directory: string
    body: SessionPromptBody
    /** Who the parent sees wrote the wake: the child, always. */
    author: ChildWakeAuthor
    /** How the turn is re-authorized: what the creating request proved about itself. */
    origin?: SessionTurnOrigin
    onSettled: () => void
  }) => Promise<"started" | "busy">
}

export type ChildSessionHost = {
  withCreation<T>(parentSessionId: string, directory: RuntimeDirectory, create: () => Promise<T>): Promise<T>
  deriveSessionId(input: { callerIdentity: string; clientRequestId: string }): string
  children(parentSessionId: string, directory: RuntimeDirectory): Promise<HostChildRow[]>
  activeChildren(parentSessionId: string, directory: RuntimeDirectory): Promise<HostChildRow[]>
  childOf(childSessionId: string, directory: RuntimeDirectory): Promise<HostChildRow | undefined>
  admitCreated(input: {
    parentSessionId: string
    childSessionId: string
    directory: RuntimeDirectory
    harness: string
    role?: string
    title?: string
    /** The creating request's verified identity, which the completion wake later runs as. */
    origin?: SessionTurnOrigin
  }): Promise<{ subagentKey: string }>
  onTurnStarted(sessionId: string, directory: RuntimeDirectory): Promise<void>
  onTurnSettled(sessionId: string, directory: RuntimeDirectory): Promise<void>
  /** Re-offers every wake still pending, once, after a restart. */
  recover(): Promise<void>
  /** Refuses new background work and waits for what is already running. */
  dispose(): void | Promise<void>
}

export function createChildSessionHost(input: ChildSessionHostInput): ChildSessionHost {
  const boundary = (directory: string) => createSubagentAdmissionBoundary({
    store: input.admission,
    publish: (parentSessionId, event) => input.publishRuntime({ directory, sessionId: parentSessionId, payload: event }),
  })
  const admit = (parentSessionId: string, directory: string, observation: SubagentObservation) =>
    boundary(directory).admit(parentSessionId, observation)
  const offering = new Set<string>()
  const creations = new Map<string, Promise<void>>()
  const pendingAttention = new Map<string, Set<string>>()
  let recovered: Promise<void> | undefined
  /**
   * Nothing this host does for itself is carried by a request, so nothing else
   * knows to wait for it. Disposal stops new work and waits for what it finds,
   * because the alternative is an offer reading a session out of a store the
   * host is closing, or asking for an adapter the workspace has already
   * refused to build.
   */
  let stopped = false
  const running = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>) => {
    running.add(work)
    void work.catch(() => {}).finally(() => running.delete(work))
    return work
  }

  async function children(parentSessionId: string, directory: RuntimeDirectory) {
    const rows = await input.listSubagents(parentSessionId, requireDirectory(directory))
    return rows.flatMap((row) => hostChildRow(parentSessionId, row) ?? [])
  }

  async function childOf(childSessionId: string, directory: RuntimeDirectory) {
    const session = await input.getSession(childSessionId, requireDirectory(directory))
    if (!session?.parentID) return undefined
    return (await children(session.parentID, directory)).find((row) => row.childSessionId === childSessionId)
  }

  async function offerWakes(parentSessionId: string, directory: string): Promise<void> {
    if (stopped || offering.has(parentSessionId)) return
    offering.add(parentSessionId)
    try {
      const parent = await input.getSession(parentSessionId, directory)
      if (!parent || parent.time?.archived !== undefined || parent.status === "busy") return
      const next = (await children(parentSessionId, directory)).find((row) => row.wake === "pending")
      if (!next) return
      const summary = childSummary(await input.getMessages(next.childSessionId, directory) ?? [])
      const origin = await input.origins?.read(parentSessionId, next.subagentKey)
      // Disposal may have begun while this offer was reading. Starting a turn
      // now would ask a closing workspace for an adapter it refuses to build.
      if (stopped) return
      const started = await input.startTurn({
        parentSessionId,
        directory,
        body: {
          messageID: wakeMessageId(next.childSessionId, summary.assistantMessageId),
          parts: [{ type: "text", text: wakeText(next, summary) }],
        },
        author: { id: next.childSessionId, name: next.label ?? "Subagent", kind: "agent" },
        ...(origin ? { origin } : {}),
        onSettled: () => {
          void track(offerWakes(parentSessionId, directory)).catch((error) => {
            console.error(`child session wake for ${parentSessionId} failed after turn`, error)
          })
        },
      })
      if (started !== "started") return
      await admit(parentSessionId, directory, {
        observationId: `host:wake:delivered:${next.childSessionId}:${randomUUID()}`,
        subagentKey: next.subagentKey,
        wake: "delivered",
      })
    } finally {
      offering.delete(parentSessionId)
    }
  }

  async function updateAttention(sessionId: string, directory: string) {
    const row = await childOf(sessionId, directory)
    if (!row) return
    const count = pendingAttention.get(sessionId)?.size ?? 0
    if ((row.attention ?? 0) === count) return
    await admit(row.parentSessionId, directory, {
      observationId: `host:attention:${sessionId}:${randomUUID()}`,
      subagentKey: row.subagentKey,
      attention: count,
    })
  }

  const unsubscribe = input.subscribeGlobal?.((event) => {
    const change = attentionChange(event.payload)
    if (!change || stopped) return
    const pending = pendingAttention.get(change.sessionId) ?? new Set<string>()
    if (change.kind === "add") pending.add(change.requestId)
    else pending.delete(change.requestId)
    pendingAttention.set(change.sessionId, pending)
    void track(updateAttention(change.sessionId, event.directory)).catch((error) => {
      console.error(`child session attention for ${change.sessionId} failed`, error)
    })
  })

  return {
    async withCreation(parentSessionId, directory, create) {
      const key = JSON.stringify([directory, parentSessionId])
      const previous = creations.get(key) ?? Promise.resolve()
      let release = () => {}
      const current = new Promise<void>((resolve) => { release = resolve })
      creations.set(key, current)
      await previous
      try {
        return await create()
      } finally {
        release()
        if (creations.get(key) === current) creations.delete(key)
      }
    },
    deriveSessionId({ callerIdentity, clientRequestId }) {
      const digest = createHmac("sha256", input.secret())
        .update(`${callerIdentity}\0${clientRequestId}`)
        .digest("hex")
      return `ses_${digest.slice(0, 32)}`
    },
    children,
    async activeChildren(parentSessionId, directory) {
      return (await children(parentSessionId, directory)).filter((row) => ACTIVE_CHILD_STATUSES.has(row.status ?? "pending"))
    },
    childOf,
    async admitCreated({ parentSessionId, childSessionId, directory, harness, role, title, origin }) {
      const event = await admit(parentSessionId, requireDirectory(directory), {
        observationId: `host:create:${childSessionId}`,
        subagentKey: `subagent_${randomUUID()}`,
        mode: "background",
        status: "pending",
        label: title ?? role ?? `${harness} subagent`,
        subagentType: role ?? harness,
        ...(title ? { description: title } : {}),
        providerKind: HOST_CHILD_PROVIDER_KIND,
        providerId: childSessionId,
        childSessionId,
        transcript: { kind: "live" },
      })
      if (origin) await input.origins?.record(parentSessionId, event.subagentKey, origin)
      return { subagentKey: event.subagentKey }
    },
    async onTurnStarted(sessionId, directory) {
      if (stopped) return
      const row = await childOf(sessionId, directory)
      if (stopped || !row || row.status !== "pending") return
      await admit(row.parentSessionId, requireDirectory(directory), {
        observationId: `host:running:${sessionId}:${randomUUID()}`,
        subagentKey: row.subagentKey,
        status: "running",
      })
    },
    async onTurnSettled(sessionId, requested) {
      if (stopped) return
      const directory = requireDirectory(requested)
      const row = await childOf(sessionId, directory)
      if (stopped) return
      if (!row) {
        await offerWakes(sessionId, directory)
        return
      }
      if (TERMINAL_CHILD_STATUSES.has(row.status ?? "")) return
      const summary = childSummary(await input.getMessages(sessionId, directory) ?? [])
      if (stopped) return
      const parent = await input.getSession(row.parentSessionId, directory)
      if (stopped) return
      const parentGone = !parent || parent.time?.archived !== undefined
      await admit(row.parentSessionId, directory, {
        observationId: `host:finished:${sessionId}:${summary.assistantMessageId ?? randomUUID()}`,
        subagentKey: row.subagentKey,
        status: parentGone ? "interrupted" : summary.status,
        ...(parentGone ? {} : { wake: "pending" }),
      })
      if (!parentGone) await offerWakes(row.parentSessionId, directory)
    },
    recover() {
      if (stopped) return Promise.resolve()
      recovered ??= track((async () => {
        for (const wake of await input.pendingWakes()) {
          await offerWakes(wake.parentSessionId, wake.directory)
        }
      })().catch((error) => {
        console.error("child session wake recovery failed", error)
      }))
      return recovered
    },
    async dispose() {
      stopped = true
      unsubscribe?.()
      // One pass is not enough on its own: an offer settling here schedules the
      // next one, and that one refuses on `stopped` and finishes, so this
      // drains rather than chases.
      while (running.size) {
        const pending = [...running]
        await Promise.allSettled(pending)
      }
    },
  }
}

/**
 * The user message id one finished child's wake turn carries.
 *
 * The `msg_` prefix is a hard constraint of the OpenCode engine:
 * `Session.Message.ID` refuses every other shape, and the refusal arrives as a
 * failed parent turn rather than a refused wake, so nothing upstream can see
 * it. The rest is derived rather than minted because the id IS the exactly-once
 * key: `Session.prompt` reconciles an id it has already admitted instead of
 * opening a second turn, so a wake re-offered after a restart — or after a lost
 * delivery observation — has to resolve to the same id from the same child.
 */
export function wakeMessageId(childSessionId: string, assistantMessageId: string | undefined): string {
  return `msg_wake_${childSessionId}_${assistantMessageId ?? "none"}`
}

/** Host-owned children always belong to a workspace directory; a create without one has nowhere to run. */
function requireDirectory(directory: RuntimeDirectory): string {
  if (directory) return directory
  throw new Error("child sessions require a workspace directory")
}

export function hostChildRow(parentSessionId: string, value: unknown): HostChildRow | undefined {
  const row = asRecord(value)
  if (!row || row.providerKind !== HOST_CHILD_PROVIDER_KIND) return undefined
  const subagentKey = str(row.subagentKey)
  const childSessionId = str(row.childSessionId)
  if (!subagentKey || !childSessionId) return undefined
  const wake = row.wake
  return {
    parentSessionId,
    subagentKey,
    childSessionId,
    ...(str(row.status) ? { status: str(row.status) } : {}),
    ...(str(row.label) ? { label: str(row.label) } : {}),
    ...(str(row.subagentType) ? { subagentType: str(row.subagentType) } : {}),
    ...(num(row.attention) !== undefined ? { attention: num(row.attention) } : {}),
    ...(wake === "pending" || wake === "delivered" ? { wake } : {}),
  }
}

type ChildSummary = { status: SubagentStatus; text: string; assistantMessageId?: string }

/**
 * The child's outcome as its transcript records it: the last assistant
 * message's error decides failed versus killed, and its text is the summary
 * the parent is woken with.
 */
export function childSummary(messages: AgentMessage[]): ChildSummary {
  const last = [...messages].reverse().find((message) => message.info.role === "assistant")
  if (!last) return { status: "completed", text: "" }
  const error = last.info.error
  const status: SubagentStatus = !error
    ? "completed"
    : error.name === "MessageAbortedError"
      ? "killed"
      : "failed"
  const text = last.parts
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim()
  const detail = error ? str(error.data?.message) ?? error.name : undefined
  return {
    status,
    text: [text, detail ? `Error: ${detail}` : undefined].filter(Boolean).join("\n\n").slice(0, WAKE_SUMMARY_MAX_CHARS),
    assistantMessageId: last.info.id,
  }
}

function wakeText(row: HostChildRow, summary: ChildSummary) {
  const heading = `Subagent "${row.label ?? row.subagentKey}"${row.subagentType ? ` (${row.subagentType})` : ""} ${summary.status}.`
  return summary.text ? `${heading}\n\n${summary.text}` : `${heading}\n\n(no summary was produced)`
}

function attentionChange(payload: CompatEnvelope["payload"]): { kind: "add" | "remove"; sessionId: string; requestId: string } | undefined {
  switch (payload.type) {
    case "permission.asked":
      return { kind: "add", sessionId: payload.properties.sessionID, requestId: `permission:${payload.properties.id}` }
    case "permission.replied":
      return { kind: "remove", sessionId: payload.properties.sessionID, requestId: `permission:${payload.properties.requestID}` }
    case "question.asked":
      return { kind: "add", sessionId: payload.properties.sessionID, requestId: `question:${payload.properties.id}` }
    case "question.replied":
    case "question.rejected":
      return { kind: "remove", sessionId: payload.properties.sessionID, requestId: `question:${payload.properties.requestID}` }
    default:
      return undefined
  }
}

export type { SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
