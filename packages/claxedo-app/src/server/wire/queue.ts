import type { QueuedPrompt, QueuedPromptControl, QueuedPromptPart, QueuedPromptSteering } from "../types"
import { asString, isRecord } from "@claxedo/helpers/guards"

function queuedPart(value: unknown): QueuedPromptPart | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined
  const partText = asString(value.text)
  const filename = asString(value.filename)
  const url = asString(value.url)
  const mime = asString(value.mime)
  return { type: value.type, ...(partText !== undefined ? { text: partText } : {}), ...(value.synthetic === true ? { synthetic: true } : {}), ...(filename !== undefined ? { filename } : {}),
    ...(url !== undefined ? { url } : {}), ...(mime !== undefined ? { mime } : {}) }
}

function steering(value: unknown): QueuedPromptSteering | undefined {
  if (!isRecord(value)) return undefined
  const mode = value.mode === "start" || value.mode === "steer" ? value.mode : undefined
  const state = value.state === "dispatching" || value.state === "accepted" || value.state === "unknown" || value.state === "rejected" ? value.state : undefined
  const operationId = asString(value.operationId)
  if (!mode || !state || !operationId) return undefined
  const message = asString(value.message)
  return { mode, operationId, state, ...(message !== undefined ? { message } : {}) }
}

export function queuedPromptFromWire(value: unknown): QueuedPrompt | undefined {
  if (!isRecord(value) || typeof value.seq !== "number" || typeof value.queuedAt !== "number") return undefined
  const messageId = asString(value.messageId)
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
  const message = asString(row.message)
  return { ok: row.ok === true, ...(status ? { status } : {}), ...(message !== undefined ? { message } : {}) }
}
