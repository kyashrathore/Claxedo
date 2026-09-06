import { sandboxFetch, type SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { record } from "../platform/json"

/**
 * `unknown`, not a caller-chosen `T`: a generic here let every call site name
 * the response type it hoped for and receive it unchecked. Callers narrow what
 * they read.
 */
export async function sandboxJson(
  ws: Workspace,
  path: string,
  init?: RequestInit,
  options: SandboxFetchOptions = {},
): Promise<unknown> {
  const res = await sandboxFetch(ws, path, init, options)
  if (!res.ok) {
    const error = record(record(await res.clone().json().catch(() => undefined))?.error)
    const message = typeof error?.message === "string" ? error.message : `sandbox request failed: ${res.status}`
    throw new Error(message)
  }
  return await res.json()
}
