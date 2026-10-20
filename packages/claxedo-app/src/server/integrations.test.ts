/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createIntegrationsApi, type ReturnSignals } from "./integrations"
import { createTransport } from "./transport"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function attempts(statuses: readonly string[]) {
  const reads: number[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      reads.push(performance.now())
      return Response.json({ status: statuses[Math.min(reads.length - 1, statuses.length - 1)] })
    },
  })
  running.push(server)
  return { reads, transport: createTransport({ serverUrl: `http://127.0.0.1:${server.port}` }) }
}

function view() {
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden" as DocumentVisibilityState })
  const target = Object.assign(new EventTarget(), { document }) as unknown as ReturnSignals & { document: EventTarget & { visibilityState: DocumentVisibilityState } }
  const returnToApp = () => {
    target.document.visibilityState = "visible"
    target.document.dispatchEvent(new Event("visibilitychange"))
  }
  return { target, returnToApp }
}

test("a redirect grant is read again the moment the person comes back to the app, not at the end of the interval", async () => {
  const { reads, transport } = attempts(["complete"])
  const { target, returnToApp } = view()
  const started = performance.now()
  const outcome = createIntegrationsApi(transport, new QueryClient(), target).awaitGrant({ attemptId: "att", url: "https://mcp.example.test/authorize", intervalMs: 5_000 }, () => true)
  setTimeout(returnToApp, 20)
  expect(await outcome).toEqual({ kind: "connected" })
  expect(reads).toHaveLength(1)
  expect(reads[0] - started).toBeLessThan(1_000)
})

test("a device grant waits out the provider's interval however the person moves between windows", async () => {
  const { reads, transport } = attempts(["complete"])
  const { target, returnToApp } = view()
  const started = performance.now()
  const outcome = createIntegrationsApi(transport, new QueryClient(), target).awaitGrant({ attemptId: "att", url: "https://github.com/login/device", userCode: "WDJB-MJHT", intervalMs: 150 }, () => true)
  setTimeout(returnToApp, 20)
  expect(await outcome).toEqual({ kind: "connected" })
  expect(reads[0] - started).toBeGreaterThanOrEqual(140)
})
