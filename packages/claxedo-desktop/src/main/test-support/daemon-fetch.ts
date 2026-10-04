/**
 * The canonical daemon fetch over a recording transport.
 *
 * Tests of main's daemon callers drive the REAL `createDaemonFetch` rather than
 * a bare stub, so each of them also proves the capability travelled — the thing
 * a hand-rolled fake would silently stop checking.
 */

import { CLAXEDO_DAEMON_CAPABILITY_HEADER, createDaemonFetch, type DaemonFetch } from "../daemon-request"

export type RecordedDaemonRequest = {
  url: string
  method?: string
  body: unknown
  capability: string | null
  headers: Headers
}

export function recordingDaemon(options: {
  origin?: string | Promise<string>
  capability?: string
  respond?: (init?: RequestInit) => Response
} = {}): { daemon: DaemonFetch; requests: RecordedDaemonRequest[] } {
  const requests: RecordedDaemonRequest[] = []
  const daemon = createDaemonFetch({
    endpoint: async () => ({
      origin: await (options.origin ?? "http://127.0.0.1:4000"),
      capability: options.capability ?? "daemon-capability",
    }),
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      requests.push({
        url: url.href,
        ...(typeof init.method === "string" ? { method: init.method } : {}),
        body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : init.body,
        capability: headers.get(CLAXEDO_DAEMON_CAPABILITY_HEADER),
        headers,
      })
      return options.respond?.(init) ?? new Response("{}", { status: 200 })
    },
  })
  return { daemon, requests }
}
