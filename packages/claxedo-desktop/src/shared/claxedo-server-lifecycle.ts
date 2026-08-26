/** IPC lifecycle contract between Electron main and the bundled local server. */
export type ClaxedoServerReadyMessage = {
  type: "claxedo-server-ready"
  port: number
}

export function claxedoServerReadyMessage(port: number): ClaxedoServerReadyMessage {
  return { type: "claxedo-server-ready", port }
}

export function parseClaxedoServerReadyMessage(input: unknown): ClaxedoServerReadyMessage | undefined {
  if (!input || typeof input !== "object") return
  const candidate = input as Partial<ClaxedoServerReadyMessage>
  if (candidate.type !== "claxedo-server-ready") return
  if (!Number.isInteger(candidate.port) || (candidate.port ?? 0) <= 0) return
  return candidate as ClaxedoServerReadyMessage
}
