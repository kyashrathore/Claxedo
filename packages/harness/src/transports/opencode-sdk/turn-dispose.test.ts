import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import type { HarnessServices, HarnessSession, TurnBroker, TurnInput } from "../../contract"
import type { Entry } from "./entry"
import type { OpenCodeRuntime } from "./runtime"
import { WorkspaceScope } from "./scope"
import { OpenCodeSdkTransport } from "./transport"

test("disposing the transport ends a turn that is waiting on engine events", async () => {
  const transport = new OpenCodeSdkTransport({} as HarnessServices, {
    databasePath: path.join(os.tmpdir(), `opencode-turn-dispose-${crypto.randomUUID()}.db`),
  })
  const state = transport as unknown as { entries: Map<string, Entry>; runtime: OpenCodeRuntime }
  const session: HarnessSession = { directory: os.tmpdir(), locality: "local", binding: {
    sessionId: "session", workspaceId: "workspace", upstreamSessionId: "upstream", directory: os.tmpdir(), connectionId: "opencode",
  } }
  state.entries.set("session", { session, start: { workspaceId: "workspace", credentials: { providers: { fake: { kind: "api" } } } },
    scope: WorkspaceScope.authorize({ workspaceID: "workspace", directory: os.tmpdir() }),
    upstream: "upstream", active: false, steers: new Set() } as unknown as Entry)
  let admitted!: () => void
  const submitted = new Promise<void>((resolve) => { admitted = resolve })
  state.runtime = { ...state.runtime,
    close: async () => {},
    events: { ...state.runtime.events, ready: async () => {}, subscribe: () => () => {}, subscribeLoss: () => () => {} },
    instances: { ready: async () => [] },
    sessions: { ...state.runtime.sessions,
      get: async () => ({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      switchModel: async () => {},
      prompt: async () => {
        admitted()
        return { createdAt: Date.now(), delivery: "start" }
      },
    },
  } as unknown as OpenCodeRuntime
  const turn = { turnId: "turn", userMessageId: "user", assistantMessageId: "assistant", todos: [], origin: { kind: "user" },
    prompt: { parts: [{ type: "text", text: "hello" }] }, model: { providerID: "fake", modelID: "m" } } as unknown as TurnInput
  const broker = { signal: new AbortController().signal } as unknown as TurnBroker

  const iterator = transport.send(session, turn, broker)[Symbol.asyncIterator]()
  const next = iterator.next()
  await submitted
  await transport.dispose()
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    next.then(() => "yielded", (error: unknown) => error),
    new Promise<"stalled">((resolve) => { timer = setTimeout(() => resolve("stalled"), 1_000) }),
  ])
  clearTimeout(timer)
  expect(settled).toMatchObject({ code: "engine" })
})
