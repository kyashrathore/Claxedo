import type { Stack } from "../harness"
import type { Workspace } from "../harness/daemon"
import type { ServerEvent } from "../../src/server/events"
import type { SessionRef } from "../../src/server/types"
import type { ServerHandle } from "../../src/server/server"
import type { Proxy } from "./tcp-proxy"

export const STEP_TIMEOUT_MS = 30_000
export const RESTART_TIMEOUT_MS = 60_000

export type Probe = { readonly stack: Stack; readonly proxy: Proxy; readonly server: ServerHandle; readonly log: EventLog; readonly workspace: Workspace }
export type EventLog = ReturnType<typeof eventLog>

export const results: { readonly name: string; readonly ok: boolean }[] = []

function describeEvent(event: ServerEvent) {
  if (event.type !== "statusChanged") return event.type
  return event.status.kind === "failed" ? `statusChanged:failed(${event.status.error.message})` : `statusChanged:${event.status.kind}`
}

export function describe(events: readonly ServerEvent[]) {
  return events.map(describeEvent).join(" ")
}

export function eventLog(server: ServerHandle) {
  const seen: ServerEvent[] = []
  const waiters = new Set<(event: ServerEvent) => void>()
  server.subscribe((event) => {
    seen.push(event)
    for (const waiter of waiters) waiter(event)
  })
  const next = <T extends ServerEvent>(name: string, from: number, match: (event: ServerEvent) => event is T, timeoutMs = STEP_TIMEOUT_MS) =>
    new Promise<T>((resolve, reject) => {
      const earlier = seen.slice(from).find(match)
      if (earlier) return resolve(earlier)
      const waiter = (event: ServerEvent) => {
        if (!match(event)) return
        waiters.delete(waiter)
        clearTimeout(timer)
        resolve(event)
      }
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`timed out waiting for ${name}; saw: ${describe(seen.slice(from))}`))
      }, timeoutMs)
      waiters.add(waiter)
    })
  return { seen, next, mark: () => seen.length }
}

export async function surfaceOf(server: ServerHandle, ref: SessionRef) {
  const reads = server.sessions.read(ref)
  const [surface] = await Promise.all([reads.surface, reads.status, reads.requests, reads.todos, reads.goal])
  return surface
}

export async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (let value = read(); ; value = read()) {
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function check(name: string, run: () => Promise<string>) {
  try {
    const detail = await run()
    results.push({ name, ok: true })
    console.log(`PASS ${name}: ${detail}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const isStatus = (sessionId: string, kinds: readonly string[]) => (event: ServerEvent): event is Extract<ServerEvent, { type: "statusChanged" }> =>
  event.type === "statusChanged" && event.ref.sessionId === sessionId && kinds.includes(event.status.kind)
