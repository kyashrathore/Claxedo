import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { OpenCodeSdkHarnessAdapter } from "./harness-adapter"
import type { ProjectedEvent } from "./event-pump"
import type { OpenCodeRuntime } from "./runtime"

function workspace() {
  return realpathSync(mkdtempSync(join(tmpdir(), "claxedo-sdk-adapter-")))
}

function runtime() {
  const listeners = new Set<(event: ProjectedEvent) => void>()
  const sessions = {
    list: mock(async (scope: { directory: string }) => ({
      sessions: [{ id: "ses_1", title: "SDK", directory: scope.directory, createdAt: 1, updatedAt: 2 }],
    })),
    get: mock(async (scope: { directory: string }, id: string) => ({
      id,
      title: "SDK",
      directory: scope.directory,
      createdAt: 1,
      updatedAt: 2,
    })),
    create: mock(async (scope: { directory: string }, input: { id?: string; title?: string }) => ({
      id: input.id ?? "ses_created",
      title: input.title,
      directory: scope.directory,
      createdAt: 1,
      updatedAt: 1,
    })),
    rename: mock(async () => {}),
    remove: mock(async () => {}),
    switchAgent: mock(async () => {}),
    switchModel: mock(async () => {}),
    prompt: mock(async (scope: { directory: string }, sessionID: string) => {
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            id: "evt_1",
            type: "session.text.delta",
            directory: scope.directory,
            hintOnly: true,
            data: { sessionID, assistantMessageID: "msg_a", ordinal: 0, delta: "hello" },
          })
          listener({
            id: "evt_2",
            type: "session.execution.succeeded",
            directory: scope.directory,
            durable: { aggregateID: sessionID, seq: 2 },
            hintOnly: false,
            data: { sessionID },
          })
        }
      })
      return { id: "msg_u", sessionID, createdAt: 1, text: "hi" }
    }),
    messages: mock(async () => ({ messages: [] })),
    interrupt: mock(async () => {}),
    fork: mock(async (scope: { directory: string }) => ({
      id: "ses_fork",
      directory: scope.directory,
      createdAt: 1,
      updatedAt: 1,
    })),
    command: mock(async () => {}),
  }
  const value = {
    sessions,
    catalog: { commands: mock(async () => []), agents: mock(async () => []), models: mock(async () => []) },
    interactions: { permissions: mock(async () => []), forms: mock(async () => []) },
    events: {
      start() {},
      ready: async () => {},
      subscribe(listener: (event: ProjectedEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      checkpoint: () => undefined,
    },
    host: { status: () => ({ lifecycle: "ready", events: "healthy" }) },
    close: async () => {},
  } as unknown as OpenCodeRuntime
  return { value, sessions }
}

describe("OpenCodeSdkHarnessAdapter", () => {
  test("uses typed session ports for lifecycle operations", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = new OpenCodeSdkHarnessAdapter({ runtime: fake.value, workspaceID: "ws_1" })

    expect(await adapter.listSessions(directory)).toEqual([
      { id: "ses_1", title: "SDK", directory, time: { created: 1, updated: 2 } },
    ])
    expect(await adapter.createSession(directory, "Created", "ses_fixed")).toEqual({ id: "ses_fixed" })
    await adapter.updateSession("ses_fixed", { title: "Renamed" }, directory)
    await adapter.deleteSession("ses_fixed", directory)

    expect(fake.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceID: "ws_1", directory }), {
      id: "ses_fixed",
      title: "Created",
    })
    expect(fake.sessions.rename).toHaveBeenCalled()
    expect(fake.sessions.remove).toHaveBeenCalled()
  })

  test("subscribes before admission and emits canonical runtime events", async () => {
    const fake = runtime()
    const directory = workspace()
    const adapter = new OpenCodeSdkHarnessAdapter({ runtime: fake.value, workspaceID: "ws_1" })
    const events = []
    for await (const event of adapter.sendMessage("ses_1", {
      parts: [{ type: "text", text: "hi" }],
      assistantMessageId: "caller-assistant-id",
      userMessageId: "caller-user-id",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    }, directory)) events.push(event)

    expect(fake.sessions.switchAgent).toHaveBeenCalledWith(expect.anything(), "ses_1", "build")
    expect(fake.sessions.switchModel).toHaveBeenCalledWith(expect.anything(), "ses_1", {
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })
    expect(events).toEqual([
      { type: "text-delta", delta: "hello", harness: "opencode" },
      { type: "finish", sessionId: "ses_1", harness: "opencode" },
    ])
  })

  test("rejects prompt content without a V2 mapping instead of fabricating it", async () => {
    const fake = runtime()
    const adapter = new OpenCodeSdkHarnessAdapter({ runtime: fake.value, workspaceID: "ws_1" })
    const events = []
    for await (const event of adapter.sendMessage("ses_1", {
      parts: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      assistantMessageId: "msg_a",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    }, workspace())) events.push(event)

    expect(fake.sessions.prompt).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ type: "error", harness: "opencode" })])
  })
})
