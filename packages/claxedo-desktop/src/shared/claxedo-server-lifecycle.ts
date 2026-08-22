/**
 * The server child's readiness handshake over Node IPC.
 *
 * `claxedo-server-entry.ts` sends this message the moment the server's listen
 * callback fires; Electron main (`main/index.ts`) resolves its `listening`
 * gate on it and cross-checks the port it assigned. Both sides import the same
 * builder/parser pair so the shape can never drift between them, and the
 * parser validates unknown IPC input instead of trusting it — the same channel
 * carries diagnostics-transport messages.
 */

const READY_TYPE = "claxedo-server-ready" as const

export type ClaxedoServerReadyMessage = {
  type: typeof READY_TYPE
  port: number
}

export function claxedoServerReadyMessage(port: number): ClaxedoServerReadyMessage {
  return { type: READY_TYPE, port }
}

export function parseClaxedoServerReadyMessage(input: unknown): ClaxedoServerReadyMessage | null {
  if (typeof input !== "object" || input === null) return null
  const record = input as Record<string, unknown>
  if (record.type !== READY_TYPE) return null
  if (typeof record.port !== "number" || !Number.isInteger(record.port)) return null
  return { type: READY_TYPE, port: record.port }
}
