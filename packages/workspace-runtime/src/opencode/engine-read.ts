import { AgentHarnessEngineError } from "@claxedo/agent-sdk-runtime/adapters"
import { num, rec, str } from "../json-value"
import type { WorkspaceScope } from "./scope"

/**
 * The shape of `@opencode-ai/sdk`'s `ClientError` for a non-2xx answer the
 * generated client did not declare: `reason` is "UnexpectedStatus" or
 * "Transport" and the status rides on `cause`. Matched structurally because a
 * static import of the SDK here would load its native module graph at startup,
 * which `host.ts` keeps behind first use.
 */
function sdkClientError(error: unknown): { reason: string; status: number | undefined } | undefined {
  if (!(error instanceof Error) || error.name !== "ClientError") return undefined
  const reason = str(rec(error)?.reason)
  if (reason === undefined) return undefined
  return { reason, status: num(rec(error.cause)?.status) }
}

/**
 * Run one engine read and name it when the engine refuses it. The generated
 * client answers a bare 500 with `ClientError: UnexpectedStatus` and nothing
 * else — no route, no location — so a rail poll that fails every 10 s for hours
 * leaves no trace of which call or workspace it was.
 */
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
