import type { Page, Response } from "playwright-core"

import { isRecord, recordField, textField } from "./json-fields"

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
      const body = await response.body()
      // `Request.timing()` is synchronous; it was previously awaited inside a
      // `Promise.all`, which said the two reads overlapped when they did not.
      const timing = response.request().timing()
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

/**
 * Read a message-list response body.
 *
 * The surface answers with either a bare array or a `{ data: [...] }`
 * envelope, and both readers below used to re-implement that choice with their
 * own assertions. Entries are returned as they arrived: a malformed one still
 * gets a row in the structure report rather than disappearing from the count.
 */
function messageList(body: Buffer): unknown[] {
  const payload: unknown = JSON.parse(body.toString("utf8"))
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  const data = payload.data
  return Array.isArray(data) ? data : []
}

export function responseSurfaceStructure(body: Buffer) {
  try {
    return messageList(body).map((message) => {
      const record = isRecord(message) ? message : {}
      const info = recordField(record, "info") ?? record
      const parts = Array.isArray(record.parts) ? record.parts : []
      return {
        role: textField(info, "role") ?? "unknown",
        serializedBytes: Buffer.byteLength(JSON.stringify(message)),
        fields: Object.entries(info)
          .filter(([name]) => !["id", "sessionID", "path"].includes(name))
          .map(([name, value]) => ({ name, serializedBytes: Buffer.byteLength(JSON.stringify(value)) }))
          .toSorted((left, right) => right.serializedBytes - left.serializedBytes || left.name.localeCompare(right.name)),
        parts: parts.map((part) => {
          const value = isRecord(part) ? part : {}
          const state = recordField(value, "state") ?? {}
          return {
            type: textField(value, "type") ?? "unknown",
            serializedBytes: Buffer.byteLength(JSON.stringify(part)),
            textBytes: Buffer.byteLength(textField(value, "text") ?? ""),
            outputBytes: Buffer.byteLength(textField(state, "output") ?? ""),
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
    for (const message of messageList(body)) {
      if (!isRecord(message)) continue
      const parts = Array.isArray(message.parts) ? message.parts : []
      for (const part of parts) {
        if (!isRecord(part)) continue
        const id = textField(part, "id")
        if (id !== undefined) observed.add(id)
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
