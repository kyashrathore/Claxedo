import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { parseSessionStateEvent, type SessionStateEvent } from "@claxedo/server-core/platform/runtime/lib/session-state-events"
import { asRecord } from "@claxedo/helpers/guards"

const MAX_FRAME_BYTES = 64 * 1024
function isSessionStateType(value: unknown): value is SessionStateEvent["type"] {
  return value === "session.status.changed" || value === "session.attention.raised" || value === "session.reader.changed" || value === "session.removed"
}

type NoticeAuthorization = {
  auth: SignedControlPlaneAuth
  visible?: (auth: SignedControlPlaneAuth, ref: SessionRef, kind?: SessionStateEvent["type"]) => Promise<boolean>
}

/** Authorization is read at public delivery, including retained replay and frames already queued in a room. */
export function authorizedSessionNotices(response: Response, options: NoticeAuthorization): Response {
  if (!response.body || !response.ok) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let line = ""
  let lines: string[] = []
  let bytes = 0
  let afterCr = false
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      for (const character of text) {
        if (afterCr) {
          afterCr = false
          if (character === "\n") continue
        }
        if (character === "\r" || character === "\n") {
          afterCr = character === "\r"
          if (line) lines.push(line)
          else {
            const frame = lines
            lines = []
            bytes = 0
            if (frame.length) controller.enqueue(encoder.encode(await authorizedFrame(frame, options)))
          }
          line = ""
          continue
        }
        line += character
        const point = character.codePointAt(0)!
        bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
        if (bytes > MAX_FRAME_BYTES) throw new Error("Control-plane event frame exceeds its byte limit")
      }
    },
    flush() {
      if (decoder.decode() || line || lines.some((value) => value.startsWith("data:"))) {
        throw new Error("Control-plane event stream ended with an incomplete frame")
      }
    },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers })
}

async function authorizedFrame(lines: readonly string[], options: NoticeAuthorization) {
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => fieldValue(line)).join("\n")
  if (!data) return `${lines.join("\n")}\n\n`
  const input: unknown = JSON.parse(data)
  const frame = noticePayload(input)
  if (!frame || !isSessionStateType(frame.type)) return `${lines.join("\n")}\n\n`
  const removed = frame.type === "session.removed" ? parseSessionStateEvent(frame) : undefined
  const userId = options.auth.principal?.userId
  const allowed = userId !== undefined && frame.ownerUserId === userId
    && (frame.type !== "session.removed" || removed !== undefined)
    && typeof frame.sessionId === "string" && !!frame.sessionId
    && typeof frame.workspaceId === "string" && !!frame.workspaceId
    && options.visible !== undefined && await options.visible(options.auth, { sessionId: frame.sessionId, workspaceId: frame.workspaceId }, frame.type)
  if (allowed && !removed) return `${lines.join("\n")}\n\n`
  const id = lines.filter((line) => line.startsWith("id:")).at(-1)
  const envelope = asRecord(input)
  const cursor = id ?? (typeof envelope?.id === "string" && !/[\r\n\0]/.test(envelope.id) ? `id: ${envelope.id}` : undefined)
  if (allowed && removed) {
    const replayed = removed.replayed === undefined && envelope?.replayed === true ? { replayed: true } : {}
    return `${cursor ? `${cursor}\n` : ""}data: ${JSON.stringify({ ...removed, ...replayed })}\n\n`
  }
  return `${cursor ? `${cursor}\n` : ""}data: {"type":"heartbeat"}\n\n`
}

function fieldValue(line: string) {
  const value = line.slice(line.indexOf(":") + 1)
  return value.startsWith(" ") ? value.slice(1) : value
}

function noticePayload(input: unknown) {
  let record = asRecord(input)
  for (let depth = 0; depth < 4 && record; depth++) {
    if (isSessionStateType(record.type)) return record
    const nested = asRecord(record.payload) ?? asRecord(record.frame)
    if (!nested) return record
    record = nested
  }
  if (record) throw new Error("Control-plane event envelope nesting exceeds its limit")
  return undefined
}
