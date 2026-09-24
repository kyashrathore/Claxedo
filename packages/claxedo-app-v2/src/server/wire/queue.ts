import type { QueuedPrompt, QueuedPromptControl, QueuedPromptPart, QueuedPromptSteering } from "../types"
import { isRecord } from "../../lib/record"

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function queuedPart(value: unknown): QueuedPromptPart | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  const partText = text(value.text)
  const filename = text(value.filename)
  return { type: value.type, ...(partText !== undefined ? { text: partText } : {}), ...(filename !== undefined ? { filename } : {}) }
}

function steering(value: unknown): QueuedPromptSteering | undefined {
  if (!isRecord(value)) return undefined
  const mode = value.mode === "start" || value.mode === "steer" ? value.mode : undefined
  const state = value.state === "dispatching" || value.state === "accepted" || value.state === "unknown" || value.state === "rejected" ? value.state : undefined
  const operationId = text(value.operationId)
  if (!mode || !state || !operationId) return undefined
  const message = text(value.message)
  return { mode, operationId, state, ...(message !== undefined ? { message } : {}) }
}

export function queuedPromptFromWire(value: unknown): QueuedPrompt | undefined {
  if (!isRecord(value) || typeof value.seq !== "number" || typeof value.queuedAt !== "number") return undefined
  const messageId = text(value.messageId)
  const steer = steering(value.steering)
  return {
    seq: value.seq,
    ...(messageId !== undefined ? { messageId } : {}),
    queuedAt: value.queuedAt,
    parts: (Array.isArray(value.parts) ? value.parts : []).flatMap((part) => {
      const parsed = queuedPart(part)
      return parsed ? [parsed] : []
    }),
    held: value.held === true,
    ...(steer ? { steering: steer } : {}),
  }
}

export function queuedPromptControlFromWire(body: unknown): QueuedPromptControl {
  const row = isRecord(body) ? body : {}
  const status = row.status === "pending" || row.status === "unknown" ? row.status : undefined
  const message = text(row.message)
  return { ok: row.ok === true, ...(status ? { status } : {}), ...(message !== undefined ? { message } : {}) }
}
