import { AgentHarnessEngineError } from "@claxedo/harness/contract"
import { asNumber as num, asRecord as rec, asString as str } from "@claxedo/helpers/guards"
import type { WorkspaceScope } from "./scope.js"

function sdkClientError(error: unknown): { reason: string; status: number | undefined } | undefined {
  if (!(error instanceof Error) || error.name !== "ClientError") return undefined
  const reason = str(rec(error)?.reason)
  if (reason === undefined) return undefined
  return { reason, status: num(rec(error.cause)?.status) }
}

export async function engineRead<T>(operation: string, scope: WorkspaceScope, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const client = sdkClientError(error)
    if (!client) throw error
    throw new AgentHarnessEngineError({
      harness: "opencode",
      operation,
      directory: scope.directory,
      ...(client.status === undefined ? { reason: client.reason } : { status: client.status }),
      cause: error,
    })
  }
}
