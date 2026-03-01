import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

export type ServerHealth = { healthy: boolean; version?: string }

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

function timeoutSignal(timeoutMs: number) {
  return (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout?.(timeoutMs)
}

export async function checkServerHealth(
  urlOrHttp: string | { url: string; username?: string; password?: string },
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const url = typeof urlOrHttp === "string" ? urlOrHttp : urlOrHttp.url
  const signal = opts?.signal ?? timeoutSignal(opts?.timeoutMs ?? 3000)
  const auth = (() => {
    if (typeof urlOrHttp === "string") return
    if (!urlOrHttp.password) return
    return {
      Authorization: `Basic ${btoa(`${urlOrHttp.username ?? "opencode"}:${urlOrHttp.password}`)}`,
    }
  })()
  const sdk = createOpencodeClient({
    baseUrl: url,
    fetch,
    signal,
    headers: auth,
  })
  return sdk.global
    .health()
    .then((x) => ({ healthy: x.data?.healthy === true, version: x.data?.version }))
    .catch(() => ({ healthy: false }))
}
