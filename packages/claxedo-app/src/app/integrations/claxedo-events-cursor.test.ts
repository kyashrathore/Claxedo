/**
 * ClaxedoEventsProvider stream-cursor behavior.
 *
 * Split out from `claxedo-events.test.ts` because this file must register
 * `mock.module` stubs BEFORE the module under test is imported (the sibling
 * file imports it statically).
 *
 * REGRESSION: this reader consumes `{directory, payload}` frames (see
 * `normalizeClaxedoStreamEvent`), so it applies directory events — permission /
 * question / message — to the shell caches. It reconnects every
 * `RECONNECT_DELAY_MS`. Servers that implement `Last-Event-ID` resume (the
 * workspace runtime does, in `workspace-runtime/src/routes/events.ts`) serve a
 * CURSOR-LESS connection the full retained log, so a reader that never sends
 * the header re-applied the entire backlog on every reconnect — re-upserting
 * `question.asked` for requests the user had already dismissed and resurrecting
 * their docks. Verified against the e2e mock: the two failing runs projected
 * `question.asked` 11 times, the passing runs exactly once.
 */
import { afterAll, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

const realApi = { ...(await import(`${import.meta.dir}/../../platform/api/api.ts?events-cursor`)) }
afterAll(() => {
  mock.module("@/platform/api/api", () => realApi)
})

const connections: Array<string | null> = []

mock.module("@/platform/api/api", () => ({
  ...realApi,
  getClaxedoServerUrl: () => "http://127.0.0.1:3001",
  authFetch: async (_input: string | URL | Request, init?: RequestInit) => {
    connections.push(new Headers(init?.headers).get("Last-Event-ID"))
    // One id-bearing frame, then end-of-stream so the reader reconnects.
    // `heartbeat` is dropped by `emitEvent`, keeping this test off every other
    // subsystem while still exercising the `id:` parse.
    return new Response('id: 7\ndata: {"type":"heartbeat"}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  },
}))

const { ClaxedoEventsProvider } = await import("./claxedo-events")

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test("the event stream resumes from Last-Event-ID on reconnect instead of replaying the log", async () => {
  const dispose = createRoot((disposer) => {
    try {
      ClaxedoEventsProvider({ children: undefined })
    } catch (error) {
      // This package has no Solid JSX transform under `bun test` (it has no
      // component-rendering tests at all), so the provider's closing
      // `return (<ClaxedoEventsContext.Provider>…)` throws "React is not
      // defined". Everything under test here — stream-target discovery and
      // `connectTarget()` — has already run by that point. Anything that is
      // not that artifact is a real failure and must propagate.
      if (!(error instanceof ReferenceError)) throw error
    }
    return disposer
  })

  try {
    // RECONNECT_DELAY_MS is 2s; allow headroom for the backoff jitter floor.
    await waitFor(() => connections.length >= 2, 8_000)
  } finally {
    dispose()
  }

  expect(connections.length).toBeGreaterThanOrEqual(2)
  // A fresh page has applied nothing yet, so the first connection is correctly
  // cursor-less and receives the full log once.
  expect(connections[0]).toBeNull()
  // The reconnect MUST resume past frame 7. Without the cursor the server
  // replays from seq 0 and every already-applied event is re-applied.
  expect(connections[1]).toBe("7")
}, 15_000)
