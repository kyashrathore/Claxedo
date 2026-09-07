import { createHmac, randomUUID } from "crypto"
import { createSubagentAdmissionBoundary, type SubagentAdmissionStore, type SubagentObservation } from "@claxedo/agent-sdk-runtime"
import type { AgentMessage, AgentSession, RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import type { SubagentStatus, SubagentUpdatedEvent, SubagentWake } from "@claxedo/agent-event-runtime"
import { asRecord } from "@claxedo/helpers/guards"
import type { CompatEnvelope } from "../compat-events"
import type { RuntimeEventEnvelopeInput } from "../runtime-event-hub"
import type { SessionPromptBody } from "../session/service"
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

export type ChildSessionHostInput = {
  admission: SubagentAdmissionStore
  /** Keyed material for idempotent child ids; must survive restarts (S12). */
  secret: () => string
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
    author: ChildWakeAuthor
    onSettled: () => void
  }) => Promise<"started" | "busy">
}

export type ChildSessionHost = {
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
  }): Promise<{ subagentKey: string }>
  onTurnStarted(sessionId: string, directory: RuntimeDirectory): Promise<void>
  onTurnSettled(sessionId: string, directory: RuntimeDirectory): Promise<void>
  /** Re-offers every wake still pending, once, after a restart. */
  recover(): Promise<void>
  dispose(): void
}

export function createChildSessionHost(input: ChildSessionHostInput): ChildSessionHost {
  const boundary = (directory: string) => createSubagentAdmissionBoundary({
    store: input.admission,
    publish: (parentSessionId, event) => input.publishRuntime({ directory, sessionId: parentSessionId, payload: event }),
  })
  const admit = (parentSessionId: string, directory: string, observation: SubagentObservation) =>
    boundary(directory).admit(parentSessionId, observation)
  const offering = new Set<string>()
  const pendingAttention = new Map<string, Set<string>>()
  let recovered: Promise<void> | undefined

  async function children(parentSessionId: string, directory: RuntimeDirectory) {
    const rows = await input.listSubagents(parentSessionId, requireDirectory(directory))
    return rows.flatMap((row) => hostChildRow(parentSessionId, row) ?? [])
  }

  async function childOf(childSessionId: string, directory: RuntimeDirectory) {
    const session = await input.getSession(childSessionId, requireDirectory(directory))
    if (!session?.parentID) return undefined
    return (await children(session.parentID, directory)).find((row) => row.childSessionId === childSessionId)
  }

  async function offerWakes(parentSessionId: string, directory: string) {
    if (offering.has(parentSessionId)) return
    offering.add(parentSessionId)
    try {
      const parent = await input.getSession(parentSessionId, directory)
      if (!parent || parent.time?.archived !== undefined || parent.status === "busy") return
      const next = (await children(parentSessionId, directory)).find((row) => row.wake === "pending")
      if (!next) return
      const summary = childSummary(await input.getMessages(next.childSessionId, directory) ?? [])
      const started = await input.startTurn({
        parentSessionId,
        directory,
        body: {
          messageID: `wake:${next.childSessionId}:${summary.assistantMessageId ?? "none"}`,
          parts: [{ type: "text", text: wakeText(next, summary) }],
        },
        author: { id: next.childSessionId, name: next.label ?? "Subagent", kind: "agent" },
        onSettled: () => {
          void offerWakes(parentSessionId, directory).catch((error) => {
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
    if (!change) return
    const pending = pendingAttention.get(change.sessionId) ?? new Set<string>()
    if (change.kind === "add") pending.add(change.requestId)
    else pending.delete(change.requestId)
    pendingAttention.set(change.sessionId, pending)
    void updateAttention(change.sessionId, event.directory).catch((error) => {
      console.error(`child session attention for ${change.sessionId} failed`, error)
    })
  })

  return {
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
    async admitCreated({ parentSessionId, childSessionId, directory, harness, role, title }) {
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
      return { subagentKey: event.subagentKey }
    },
    async onTurnStarted(sessionId, directory) {
      const row = await childOf(sessionId, directory)
      if (!row || row.status !== "pending") return
      await admit(row.parentSessionId, requireDirectory(directory), {
        observationId: `host:running:${sessionId}:${randomUUID()}`,
        subagentKey: row.subagentKey,
        status: "running",
      })
    },
    async onTurnSettled(sessionId, requested) {
      const directory = requireDirectory(requested)
      const row = await childOf(sessionId, directory)
      if (!row) {
        await offerWakes(sessionId, directory)
        return
      }
      if (TERMINAL_CHILD_STATUSES.has(row.status ?? "")) return
      const summary = childSummary(await input.getMessages(sessionId, directory) ?? [])
      const parent = await input.getSession(row.parentSessionId, directory)
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
      recovered ??= (async () => {
        for (const wake of await input.pendingWakes()) {
          await offerWakes(wake.parentSessionId, wake.directory)
        }
      })().catch((error) => {
        console.error("child session wake recovery failed", error)
      })
      return recovered
    },
    dispose() {
      unsubscribe?.()
    },
  }
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

export type { SubagentUpdatedEvent }
