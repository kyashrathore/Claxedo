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

import { readNumber, readUnknown } from "./json-read"

const READY_TYPE = "claxedo-server-ready" as const

export type ClaxedoServerReadyMessage = {
  type: typeof READY_TYPE
  port: number
}

export function claxedoServerReadyMessage(port: number): ClaxedoServerReadyMessage {
  return { type: READY_TYPE, port }
}

export function parseClaxedoServerReadyMessage(input: unknown): ClaxedoServerReadyMessage | null {
  if (readUnknown(input, "type") !== READY_TYPE) return null
  const port = readNumber(input, "port")
  if (port === undefined || !Number.isInteger(port)) return null
  return { type: READY_TYPE, port }
}
