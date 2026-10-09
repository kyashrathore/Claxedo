import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import type { HarnessServices, HarnessSession } from "../../contract"
import type { Entry } from "./entry"
import type { OpenCodeRuntime } from "./runtime"
import { WorkspaceScope } from "./scope"
import { OpenCodeSdkTransport } from "./transport"

function stalledInterrupt() {
  const transport = new OpenCodeSdkTransport({} as HarnessServices, {
    databasePath: path.join(os.tmpdir(), `opencode-cancel-${crypto.randomUUID()}.db`),
  })
  const state = transport as unknown as { entries: Map<string, Entry>; runtime: OpenCodeRuntime }
  const session: HarnessSession = { directory: os.tmpdir(), locality: "local", binding: {
    sessionId: "session", workspaceId: "workspace", upstreamSessionId: "upstream", directory: os.tmpdir(), connectionId: "opencode",
  } }
  state.entries.set("session", { session, start: { workspaceId: "workspace" },
    scope: WorkspaceScope.authorize({ workspaceID: "workspace", directory: os.tmpdir() }),
    assistantMessageID: "assistant", upstream: "upstream", active: true } as Entry)
  let subscriptions = 0
  let release!: () => void
  const interrupt = new Promise<void>((resolve) => { release = resolve })
  state.runtime = { ...state.runtime,
    sessions: { ...state.runtime.sessions, interrupt: () => interrupt },
    events: { ...state.runtime.events, subscribe: () => {
      subscriptions += 1
      return () => { subscriptions -= 1 }
    } },
  }
  return { transport, session, release, subscriptions: () => subscriptions }
}

for (const reason of ["deadline", "signal"] as const) {
  test(`a stalled interrupt obeys the ${reason} and releases its subscription`, async () => {
    const context = stalledInterrupt()
    const controller = new AbortController()
    const deadline = { at: Date.now() + (reason === "deadline" ? 15 : 60_000), signal: controller.signal }
    const pending = context.transport.cancel(context.session, { turnId: "turn", assistantMessageId: "assistant" }, deadline)
    if (reason === "signal") controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([pending, new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), 150)
      })])
      expect(result).toEqual({ execution: "running", cleanup: "unknown" })
      expect(context.subscriptions()).toBe(0)
    } finally {
      clearTimeout(timer)
      controller.abort()
      context.release()
      await pending
      await context.transport.dispose()
    }
  })
}
