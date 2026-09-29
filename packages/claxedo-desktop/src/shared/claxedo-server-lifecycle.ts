/**
 * The server child's readiness handshake over Node IPC.
 *
 * `src/server/entry.ts` sends this message the moment the server's listen
 * callback fires; Electron main (`main/index.ts`) resolves its `listening`
 * gate on it and cross-checks the port it assigned. Both sides import the same
 * builder/parser pair so the shape can never drift between them, and the
 * parser validates unknown IPC input instead of trusting it — the same channel
 * carries diagnostics-transport messages.
 */

import { readField, readFiniteNumber } from "@claxedo/helpers/readers"

const READY_TYPE = "claxedo-server-ready" as const

export type ClaxedoServerReadyMessage = {
  type: typeof READY_TYPE
  port: number
}

export function claxedoServerReadyMessage(port: number): ClaxedoServerReadyMessage {
  return { type: READY_TYPE, port }
}

export function parseClaxedoServerReadyMessage(input: unknown): ClaxedoServerReadyMessage | null {
  if (readField(input, "type") !== READY_TYPE) return null
  const port = readFiniteNumber(input, "port")
  if (port === undefined || !Number.isInteger(port)) return null
  return { type: READY_TYPE, port }
}

/**
 * The daemon exits with this, before it announces its port, when the operating
 * system will not tell it its own creation identity. A discovery record without
 * one would give a later launcher nothing to verify before signalling it.
 */
export const CLAXEDO_SERVER_IDENTITY_UNREADABLE_EXIT_CODE = 71

export function claxedoServerExitedBeforeListening(code: number | null, logPath: string) {
  if (code === CLAXEDO_SERVER_IDENTITY_UNREADABLE_EXIT_CODE) {
    return `The Claxedo server could not read its own process identity from the operating system and stopped `
      + `(exit code ${code}). The cause is in ${logPath}.`
  }
  return `claxedo-server exited before listening (code ${String(code)})`
}
