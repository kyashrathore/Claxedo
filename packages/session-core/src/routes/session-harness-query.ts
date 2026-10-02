import { HTTPException } from "hono/http-exception"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"

export const RUNTIME_NATIVE_HARNESS_IDS = ["claude", "codex", "cursor", "pi", "opencode"] as const

export function requestedSessionHarness(req: { query(name: string): string | undefined }): SessionHarness | undefined {
  const nativeHarness = req.query("nativeHarness")
  const connectionId = req.query("connectionId")
  if (req.query("harness") !== undefined || req.query("runner") !== undefined) {
    throw new HTTPException(400, { message: "Use nativeHarness or connectionId to select a harness" })
  }
  if (nativeHarness !== undefined && connectionId !== undefined) {
    throw new HTTPException(400, { message: "Select either nativeHarness or connectionId" })
  }
  if (nativeHarness !== undefined) {
    if (!RUNTIME_NATIVE_HARNESS_IDS.some((id) => id === nativeHarness)) {
      throw new HTTPException(400, { message: "Unknown native harness" })
    }
    return { id: nativeHarness, access: "native" }
  }
  if (connectionId !== undefined) {
    if (!connectionId.trim()) throw new HTTPException(400, { message: "connectionId must not be empty" })
    return { id: connectionId, access: "connection" }
  }
  return undefined
}

