import { randomUUID } from "node:crypto"
import type { PromptDelivery } from "@claxedo/agent-sdk-runtime"
import type { SessionPromptBody } from "./service"
import type { SessionTurnOrigin } from "../session-access-policy"
import type { QueuedPromptRecord, QueuedPromptAttempt } from "../store"

export type QueuedPromptAction = "cancel" | "steer" | "hold" | "release" | { replace: NonNullable<QueuedPromptRecord["parts"]> }

type SteeringResult = NonNullable<Awaited<ReturnType<import("@claxedo/agent-sdk-runtime").AgentRuntime["turns"]["start"]>>["steering"]>
export type QueuedControlResult = { ok: true } | { ok: false; status: "pending" | "rejected" | "unknown" | "conflict" | "provider_owned"; message: string; operationId?: string }
export type QueuedPromptRequester = Pick<QueuedPromptRecord, "actor" | "author" | "authority" | "provenance">
export type SessionDeliveryStore = {
  queuePrompt(input: Omit<QueuedPromptRecord, "seq" | "queuedAt" | "held" | "steering">): QueuedPromptRecord
  deleteQueuedPrompt(sessionId: string, seq: number): boolean
  replaceQueuedPromptParts(sessionId: string, seq: number, parts: QueuedPromptRecord["parts"]): boolean
  listQueuedPrompts(): QueuedPromptRecord[]
  claimQueuedPromptDelivery(sessionId: string, seq: number, operationId: string, mode: "start" | "steer"): boolean
  settleQueuedPromptDelivery(sessionId: string, seq: number, steering: QueuedPromptAttempt): boolean
  setQueuedPromptHeld(sessionId: string, seq: number, held: boolean): boolean
  completeQueuedPrompt(sessionId: string, seq: number, operationId: string): boolean
  sessionDirectory(sessionId: string): string | undefined
}
type Submission = { sessionId: string; body: SessionPromptBody } & QueuedPromptRequester
export type SessionDeliveryOwner = {
  list(sessionId: string): Array<QueuedPromptRecord & { held: boolean }>
  control(sessionId: string, seq: number, action: QueuedPromptAction): Promise<QueuedControlResult>
  queue(input: Submission): QueuedPromptRecord
  steer(input: Submission): Promise<QueuedControlResult>
  wake(sessionId: string): void
  recover(): Promise<void>
  dispose(): Promise<void>
}

/** One runtime-owned executor. HTTP observes attempts; it never owns a waiter. */
export function createSessionDeliveryOwner(input: {
  store: () => SessionDeliveryStore | undefined
  /**
   * Resolves when this owner holds the session's next turn. `unavailable` means
   * the runtime shut down while the prompt was parked: nothing was granted, and
   * the queued rows stay where they are for the next owner to drain.
   */
  whenIdle: (sessionId: string, directory: string) => Promise<{ abandon(): void; unavailable?: true }>
  startTurn: (input: {
    sessionId: string
    directory: string
    body: SessionPromptBody
    author?: QueuedPromptRecord["author"]
    /** Rebuilt from the row: how the request that queued this reached the runtime. */
    origin?: SessionTurnOrigin
    onDelivery: (delivery: PromptDelivery) => void
    onSteeringResult?: (result: SteeringResult) => void
  }) => Promise<unknown>
}): SessionDeliveryOwner {
  const operations = new Map<string, Promise<QueuedControlResult>>()
  const draining = new Map<string, Promise<void>>()
  const revisions = new Map<string, number>()
  let disposed = false
  const store = () => {
    const target = input.store()
    if (!target) throw new Error("This runtime cannot persist queued input")
    return target
  }
  const row = (sessionId: string, seq: number) => store().listQueuedPrompts().find((item) => item.sessionId === sessionId && item.seq === seq)
  const eligible = (item: QueuedPromptRecord) => !item.held && (!item.steering || item.steering.state === "rejected")
  const next = (sessionId: string) => store().listQueuedPrompts()
    .filter((item) => item.sessionId === sessionId && eligible(item)).sort((a, b) => a.seq - b.seq)[0]
  const persist = ({ sessionId, body, actor, author, authority, provenance }: Submission) => {
    if (disposed) throw new Error("Session delivery owner is disposed")
    return store().queuePrompt({
      sessionId, ...queuedPromptColumns(body), messageId: body.messageID ?? `msg_${randomUUID()}`,
      actor, author, authority, provenance,
    })
  }
  function settle(record: QueuedPromptRecord, operationId: string, mode: "start" | "steer", result: SteeringResult): QueuedControlResult {
    const state = result.ok ? "accepted" : result.status === "unknown" ? "unknown" : "rejected"
    const message = result.ok ? undefined : result.message
    if (!store().settleQueuedPromptDelivery(record.sessionId, record.seq, { operationId, mode, state, message })) {
      return { ok: false, status: "conflict", message: "Delivery ownership changed", operationId }
    }
    return result.ok ? { ok: true } : { ok: false, status: state === "unknown" ? "unknown" : "rejected", message: result.message, operationId }
  }
  async function dispatch(record: QueuedPromptRecord, operationId: string, mode: "start" | "steer"): Promise<QueuedControlResult> {
    const directory = store().sessionDirectory(record.sessionId)
    if (!directory || disposed) return settle(record, operationId, mode, { ok: false, status: "declined", message: "Session delivery is unavailable" })
    let delivery: PromptDelivery | undefined
    let steering: SteeringResult | undefined
    const origin = queuedPromptOrigin(record)
    try {
      await input.startTurn({ sessionId: record.sessionId, directory,
        body: { ...queuedPromptBody(record), delivery: mode === "steer" ? "steer" : "queue" },
        author: record.author, ...(origin ? { origin } : {}),
        onDelivery: (value) => { delivery = value },
        onSteeringResult: (value) => { steering = value },
      })
      if (mode === "steer") return settle(record, operationId, mode, steering ?? { ok: false, status: "unknown", message: "Runtime did not report a steering outcome" })
      if (delivery === "start") {
        return store().completeQueuedPrompt(record.sessionId, record.seq, operationId)
          ? { ok: true } : { ok: false, status: "conflict", message: "Delivery ownership changed", operationId }
      }
      if (steering && !steering.ok) return settle(record, operationId, mode, steering)
      return settle(record, operationId, mode, { ok: false, status: delivery === "queue" ? "declined" : "unknown",
        message: delivery === "queue" ? "Session is still busy" : "Runtime did not report admission" })
    } catch (error) {
      return settle(record, operationId, mode, { ok: false, status: "unknown", message: error instanceof Error ? error.message : "Delivery outcome is unknown" })
    }
  }
  function claim(record: QueuedPromptRecord, mode: "start" | "steer") {
    const operationId = randomUUID()
    if (!store().claimQueuedPromptDelivery(record.sessionId, record.seq, operationId, mode)) return undefined
    const claimed = row(record.sessionId, record.seq)
    if (!claimed || claimed.steering?.operationId !== operationId) return undefined
    const promise = dispatch(claimed, operationId, mode)
    operations.set(operationId, promise)
    void promise.then((result) => {
      if (mode === "steer" && !result.ok && result.status === "rejected") kick(record.sessionId)
    }).finally(() => operations.delete(operationId)).catch(() => {})
    return { operationId, promise }
  }
  function kick(sessionId: string): void {
    if (disposed) return
    const revision = (revisions.get(sessionId) ?? 0) + 1
    revisions.set(sessionId, revision)
    if (draining.has(sessionId)) return
    const task = Promise.resolve().then(async () => {
      for (;;) {
        if (disposed) return
        const candidate = next(sessionId)
        if (!candidate) return
        const directory = store().sessionDirectory(sessionId)
        if (!directory) { store().deleteQueuedPrompt(sessionId, candidate.seq); continue }
        const handoff = await input.whenIdle(sessionId, directory)
        if (handoff.unavailable) return
        try {
          if (disposed) return
          // A control or another owner may have changed the queue while idle
          // admission was pending. Only the freshly read durable row may run.
          const current = next(sessionId)
          if (!current) return
          const attempt = claim(current, "start")
          if (!attempt) return
          const result = await attempt.promise
          if (!result.ok) return
        } finally { handoff.abandon() }
      }
    }).catch((error) => console.error("session delivery failed", error)).finally(() => {
      draining.delete(sessionId)
      if (!disposed && revisions.get(sessionId) !== revision) kick(sessionId)
      else revisions.delete(sessionId)
    })
    draining.set(sessionId, task)
  }
  async function control(sessionId: string, seq: number, action: QueuedPromptAction): Promise<QueuedControlResult> {
    if (disposed) return { ok: false, status: "conflict", message: "Session delivery owner is disposed" }
    const current = row(sessionId, seq)
    if (!current) return { ok: false, status: "conflict", message: "Queued message is not available" }
    if (current.steering && current.steering.state !== "rejected") {
      const attempt = current.steering
      if (action !== "steer" || attempt.mode === "start") return { ok: false, status: "provider_owned", message: "Provider-held or uncertain input cannot be edited or cancelled locally" }
      if (attempt.state === "accepted") return { ok: true }
      const observing = operations.get(attempt.operationId)
      return observing ? observeDeliveryAcknowledgement(observing, attempt.operationId)
        : { ok: false, status: attempt.state === "unknown" ? "unknown" : "pending", operationId: attempt.operationId,
          message: attempt.message ?? "Awaiting provider acknowledgement; this input will not be resent" }
    }
    if (action === "steer") {
      const attempt = claim(current, "steer")
      if (!attempt) {
        const currentAttempt = row(sessionId, seq)?.steering
        return currentAttempt
          ? { ok: false, status: "pending", message: "Another delivery operation owns this input", operationId: currentAttempt.operationId }
          : { ok: false, status: "conflict", message: "Delivery ownership changed" }
      }
      const result = await observeDeliveryAcknowledgement(attempt.promise, attempt.operationId)
      // An explicit refusal leaves the normal queue policy in place. Unknown
      // outcomes stay ineligible, including after a restart.
      return result
    }
    if (action === "cancel") {
      if (!store().deleteQueuedPrompt(sessionId, seq)) return { ok: false, status: "conflict", message: "Delivery ownership changed" }
    } else {
      const changed = typeof action === "object"
        ? store().replaceQueuedPromptParts(sessionId, seq, action.replace)
        : store().setQueuedPromptHeld(sessionId, seq, action === "hold")
      if (!changed) return { ok: false, status: "conflict", message: "Delivery ownership changed" }
    }
    kick(sessionId)
    return { ok: true }
  }
  return {
    list: (sessionId) => store().listQueuedPrompts().filter((item) => item.sessionId === sessionId).map((item) => ({ ...item, held: !!item.held })),
    queue(submission) { const record = persist(submission); kick(record.sessionId); return record },
    steer(submission) { const record = persist(submission); return control(record.sessionId, record.seq, "steer") },
    control,
    wake: kick,
    async recover() {
      if (!input.store() || disposed) return
      for (const sessionId of new Set(store().listQueuedPrompts().filter(eligible).map((item) => item.sessionId))) kick(sessionId)
    },
    async dispose() { disposed = true; await Promise.allSettled(operations.values()) },
  }
}

function queuedPromptColumns(body: SessionPromptBody): Omit<QueuedPromptRecord, "sessionId" | "seq" | "queuedAt" | "actor" | "author"> {
  return {
    parts: body.parts ?? [],
    ...(body.messageID ? { messageId: body.messageID } : {}),
    ...(body.agent ? { agent: body.agent } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(body.system ? { system: body.system } : {}),
    ...(body.variant === undefined ? {} : { variant: body.variant }),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
    delivery: body.delivery ?? "queue",
  }
}

/**
 * The origin a stored row runs under, or nothing for a row queued before
 * provenance was recorded — which is never re-issued rather than re-issued as
 * whoever happens to be composed now.
 */
function queuedPromptOrigin(row: QueuedPromptRecord): SessionTurnOrigin | undefined {
  if (row.provenance === "loopback-direct") return { provenance: "loopback-direct" }
  if (row.provenance !== "relay-replayed" || !row.actor || !row.authority) return undefined
  return { provenance: "relay-replayed", actor: row.actor, authority: row.authority }
}

function queuedPromptBody(row: QueuedPromptRecord): SessionPromptBody {
  return {
    parts: row.parts,
    ...(row.messageId ? { messageID: row.messageId } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.tools ? { tools: row.tools } : {}),
    ...(row.format ? { format: row.format } : {}),
    ...(row.system ? { system: row.system } : {}),
    ...(row.variant === undefined ? {} : { variant: row.variant }),
    ...(row.permissionMode ? { permissionMode: row.permissionMode } : {}),
    delivery: row.delivery,
  }
}

/** HTTP observes the operation for a bounded interval; the operation keeps running. */
async function observeDeliveryAcknowledgement(promise: Promise<QueuedControlResult>, operationId: string): Promise<QueuedControlResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<QueuedControlResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, status: "pending", operationId, message: "Awaiting provider acknowledgement" }), 1000)
    })])
  } finally { clearTimeout(timer) }
}
