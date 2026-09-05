import { sandboxFetch, type SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

export async function sandboxJson<T>(
  ws: Workspace,
  path: string,
  init?: RequestInit,
  options: SandboxFetchOptions = {},
) {
  const res = await sandboxFetch(ws, path, init, options)
  if (!res.ok) {
    const body = await res.clone().json().catch(() => undefined)
    const error = body && typeof body === "object" && !Array.isArray(body) ? body.error : undefined
    const message = error && typeof error === "object" && !Array.isArray(error) && typeof error.message === "string"
      ? error.message
      : `sandbox request failed: ${res.status}`
    throw new Error(message)
  }
  return await res.json() as T
}
