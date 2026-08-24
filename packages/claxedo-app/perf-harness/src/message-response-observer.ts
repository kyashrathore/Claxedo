import type { Page, Response } from "playwright"

export type MessageResponseObservation = {
  observed: boolean
  status?: number
  ok?: boolean
  responseBodyBytes?: number
  encodedBodyBytes?: number
  responseHeaderBytes?: number
  timing?: { startTimeMs: number; responseStartMs: number; responseEndMs: number }
  firstSurface?: Array<{
    role: string
    serializedBytes: number
    fields: Array<{ name: string; serializedBytes: number }>
    parts: Array<{ type: string; serializedBytes: number; textBytes: number; outputBytes: number }>
  }>
}

export type EventualLatestTurnResponseObservation = {
  observed: boolean
  status?: number
  expectedPartCount: number
  observedPartCount: number
  missingPartCount: number
  passed: boolean
}

/** Arm before the trusted click; finish only after stable paint is measured. */
export function armMessageResponseObservation(page: Page, sessionId: string) {
  let response: Response | undefined
  let resolveResponse: ((value: Response) => void) | undefined
  const matched = new Promise<Response>((resolve) => { resolveResponse = resolve })
  const listener = (candidate: Response) => {
    if (response || !isDestinationMessageResponse(candidate.url(), sessionId)) return
    response = candidate
    resolveResponse?.(candidate)
  }
  page.on("response", listener)

  return async (expectsNetwork: boolean): Promise<MessageResponseObservation> => {
    try {
      if (!response) {
        if (expectsNetwork) {
          response = await Promise.race([
            matched,
            new Promise<undefined>((resolve) => setTimeout(resolve, 5_000)),
          ])
        } else {
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
        }
      }
      if (!response) return { observed: false }
      const [body, timing] = await Promise.all([
        response.body(),
        response.request().timing(),
      ])
      const headers = await response.allHeaders()
      const contentLength = Number(headers["content-length"])
      return {
        observed: true,
        status: response.status(),
        ok: response.ok(),
        responseBodyBytes: body.byteLength,
        encodedBodyBytes: Number.isFinite(contentLength) ? contentLength : undefined,
        responseHeaderBytes: Object.entries(headers).reduce(
          (bytes, [name, value]) => bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
          2,
        ),
        timing: {
          startTimeMs: timing.startTime,
          responseStartMs: timing.responseStart,
          responseEndMs: timing.responseEnd,
        },
        firstSurface: responseSurfaceStructure(body),
      }
    } finally {
      page.off("response", listener)
    }
  }
}

/**
 * Observe the authoritative raw post-quiet `latest-turn` response without
 * persisting any canonical part identity. This intentionally validates the
 * producer before `storedMessageParts` filters non-renderable control parts;
 * it does not claim those control parts exist in normalized client state.
 */
export function armEventualLatestTurnResponseObservation(
  page: Page,
  sessionId: string,
  expectedPartIds: readonly string[],
) {
  let response: Response | undefined
  let resolveResponse: ((value: Response) => void) | undefined
  const matched = new Promise<Response>((resolve) => { resolveResponse = resolve })
  const listener = (candidate: Response) => {
    if (response || !isDestinationMessageResponse(candidate.url(), sessionId, "latest-turn")) return
    response = candidate
    resolveResponse?.(candidate)
  }
  page.on("response", listener)

  return async (): Promise<EventualLatestTurnResponseObservation> => {
    try {
      response ??= await Promise.race([
        matched,
        new Promise<undefined>((resolve) => setTimeout(resolve, 10_000)),
      ])
      if (!response) {
        return {
          observed: false,
          expectedPartCount: expectedPartIds.length,
          observedPartCount: 0,
          missingPartCount: expectedPartIds.length,
          passed: false,
        }
      }
      const coverage = fullHydrationPartCoverage(await response.body(), expectedPartIds)
      return {
        observed: true,
        status: response.status(),
        ...coverage,
        passed: response.ok() && coverage.missingPartCount === 0,
      }
    } finally {
      page.off("response", listener)
    }
  }
}

export function responseSurfaceStructure(body: Buffer) {
  try {
    const payload = JSON.parse(body.toString("utf8")) as unknown
    const messages = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : []
    return messages.map((message) => {
      const record = message && typeof message === "object" ? message as Record<string, unknown> : {}
      const info = record.info && typeof record.info === "object" ? record.info as Record<string, unknown> : record
      const parts = Array.isArray(record.parts) ? record.parts : []
      return {
        role: typeof info.role === "string" ? info.role : "unknown",
        serializedBytes: Buffer.byteLength(JSON.stringify(message)),
        fields: Object.entries(info)
          .filter(([name]) => !["id", "sessionID", "path"].includes(name))
          .map(([name, value]) => ({ name, serializedBytes: Buffer.byteLength(JSON.stringify(value)) }))
          .toSorted((left, right) => right.serializedBytes - left.serializedBytes || left.name.localeCompare(right.name)),
        parts: parts.map((part) => {
          const value = part && typeof part === "object" ? part as Record<string, unknown> : {}
          const state = value.state && typeof value.state === "object" ? value.state as Record<string, unknown> : {}
          return {
            type: typeof value.type === "string" ? value.type : "unknown",
            serializedBytes: Buffer.byteLength(JSON.stringify(part)),
            textBytes: typeof value.text === "string" ? Buffer.byteLength(value.text) : 0,
            outputBytes: typeof state.output === "string" ? Buffer.byteLength(state.output) : 0,
          }
        }),
      }
    })
  } catch {
    return undefined
  }
}

export function fullHydrationPartCoverage(body: Buffer, expectedPartIds: readonly string[]) {
  const observed = new Set<string>()
  try {
    const payload = JSON.parse(body.toString("utf8")) as unknown
    const messages = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : []
    for (const message of messages) {
      if (!message || typeof message !== "object") continue
      const parts = Array.isArray((message as { parts?: unknown }).parts)
        ? (message as { parts: unknown[] }).parts
        : []
      for (const part of parts) {
        if (!part || typeof part !== "object") continue
        const id = (part as { id?: unknown }).id
        if (typeof id === "string") observed.add(id)
      }
    }
  } catch {}
  const missingPartCount = expectedPartIds.reduce((count, id) => count + (observed.has(id) ? 0 : 1), 0)
  return {
    expectedPartCount: expectedPartIds.length,
    observedPartCount: observed.size,
    missingPartCount,
  }
}

export function isDestinationMessageResponse(
  url: string,
  sessionId: string,
  view?: "latest-turn" | "latest-surface",
) {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const session = segments.lastIndexOf("session")
    return session >= 0 && segments[session + 1] === sessionId && segments[session + 2] === "message" &&
      (view === undefined || parsed.searchParams.get("view") === view)
  } catch {
    return false
  }
}
