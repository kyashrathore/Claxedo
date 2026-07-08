import {
  apiPath,
  extractError,
  extractText,
  type OpencodePromptResult,
} from "./page-arena-format"
import type { PageArenaSettings } from "./page-arena-settings"

export async function createArenaSession(origin: string, directory: string, body: Record<string, unknown>) {
  const data = (await opencodeFetch(origin, directory, "/session", {
    method: "POST",
    body: JSON.stringify(body),
  })) as { id?: string; data?: { id?: string } } | null
  const sid = clean(data?.id || data?.data?.id)
  if (!sid) throw new Error("OpenCode did not return a session id")
  return sid
}

export async function promptSession(
  origin: string,
  directory: string,
  sessionID: string,
  system: string,
  prompt: string,
  model: { providerID: string; modelID: string } | undefined,
  settings: PageArenaSettings,
  signal?: AbortSignal,
) {
  const result = (await opencodeFetch(origin, directory, `/session/${encodeURIComponent(sessionID)}/message`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      agent: settings.agent,
      system,
      model,
      parts: [{ type: "text", text: prompt }],
    }),
  })) as OpencodePromptResult | null

  const firstErr = extractError(result)
  let full = result
  let text = extractText(result?.parts)
  if (!text && result?.info?.id) {
    const detail = (await opencodeFetch(
      origin,
      directory,
      `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(result.info.id)}`,
      { method: "GET", signal },
    )) as OpencodePromptResult | null
    const nextErr = extractError(detail)
    if (nextErr) throw new Error(nextErr)
    full = detail || result
    text = extractText(detail?.parts)
  }
  if (!text && firstErr) throw new Error(firstErr)
  if (!text) throw new Error("OpenCode returned empty output")

  return {
    text,
    parts: full?.parts || result?.parts || [],
  }
}

async function opencodeFetch(origin: string, directory: string, pathname: string, init: RequestInit) {
  const timeout = AbortSignal.timeout(90_000)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const res = await fetch(`${origin}${apiPath(pathname, directory)}`, {
    ...init,
    signal,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  if (res.ok) {
    if (res.status === 204) return null
    const text = await res.text()
    if (!text.trim()) return null
    return JSON.parse(text) as unknown
  }
  const body = await res.text().catch(() => "")
  const message = body || `OpenCode request failed (${res.status})`
  const error = new Error(message) as Error & { status?: number }
  error.status = res.status
  throw error
}

function clean(input: unknown) {
  return typeof input === "string" ? input.trim() : ""
}
