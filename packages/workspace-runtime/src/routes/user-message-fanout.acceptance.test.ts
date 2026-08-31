import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type {
  AgentHarnessAdapter,
} from "@claxedo/agent-sdk-runtime/adapters"
import type { AgentRuntimeStreamEvent } from "@claxedo/agent-sdk-runtime"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { messagePartUpdated, messageUpdated, sessionIdle } from "../compat-events"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { createWorkspaceHost, type WorkspaceHarnessRegistry } from "../workspace/runtime"

const roots: string[] = []
const originalDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
const originalWorkspaceId = process.env.WORKSPACE_RUNTIME_WORKSPACE_ID

afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  else process.env.WORKSPACE_RUNTIME_DIRECTORY = originalDirectory
  if (originalWorkspaceId === undefined) delete process.env.WORKSPACE_RUNTIME_WORKSPACE_ID
  else process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = originalWorkspaceId
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type SseClient = {
  frames: () => Array<Record<string, unknown>>
  until: (predicate: (frames: Array<Record<string, unknown>>) => boolean) => Promise<Array<Record<string, unknown>>>
  close: () => void
}

async function connect(app: Hono, directory: string): Promise<SseClient> {
  const controller = new AbortController()
  const response = await app.request(`http://runtime.test/global/event?directory=${encodeURIComponent(directory)}`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const received: Array<Record<string, unknown>> = []
  const drain = () => {
    const blocks = buffer.split("\n\n")
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim()
      if (!data) continue
      const parsed = JSON.parse(data)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) received.push(parsed)
    }
  }
  return {
    frames: () => [...received],
    async until(predicate) {
      for (let reads = 0; reads < 80; reads += 1) {
        drain()
        if (predicate(received)) return [...received]
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
      }
      drain()
      if (predicate(received)) return [...received]
      throw new Error(`SSE predicate was not satisfied: ${JSON.stringify(received)}`)
    },
    close: () => controller.abort(),
  }
}

function payload(frame: Record<string, unknown>) {
  const value = frame.payload
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function properties(frame: Record<string, unknown>) {
  const value = payload(frame)?.properties
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function info(frame: Record<string, unknown>) {
  const value = properties(frame)?.info
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isUserMessage(frame: Record<string, unknown>, messageId: string) {
  return payload(frame)?.type === "message.updated" && info(frame)?.role === "user" && info(frame)?.id === messageId
}

function isAssistantOutput(frame: Record<string, unknown>) {
  return payload(frame)?.type === "message.part.delta"
    || payload(frame)?.type === "message.part.updated"
    || payload(frame)?.type === "message.updated" && info(frame)?.role === "assistant"
}

function isIdle(frame: Record<string, unknown>) {
  return payload(frame)?.type === "session.idle"
}

function acpFixture(): AgentHarnessAdapter {
  return {
    async listSessions() {
      return []
    },
    async getSession(id) {
      return { id, title: "ACP acceptance", time: { created: 1, updated: 1 } }
    },
    async createSession(_directory, _title, id) {
      return { id: id ?? "ses_acp" }
    },
    async updateSession(id) {
      return { id, title: "ACP acceptance", time: { created: 1, updated: 1 } }
    },
    async deleteSession() {},
    async getSessionConfig() {
      return { harness: { id: "codex", access: "acp" }, agent: "build", variant: null }
    },
    async updateSessionConfig() {
      return { harness: { id: "codex", access: "acp" }, agent: "build", variant: null }
    },
    readHarnessCapabilities() {
      return {
        harness: "codex",
        abort: false,
        reconnect: false,
        replay: true,
        permissions: false,
        questions: false,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: false,
        subagents: false,
        goals: false,
      }
    },
    async *sendMessage(sessionId, input): AsyncIterable<AgentRuntimeStreamEvent> {
      yield messageUpdated({
        id: input.userMessageId!,
        sessionID: sessionId,
        role: "user",
        time: { created: 1 },
        agent: input.agent ?? "build",
        model: input.model ?? { providerID: "codex", modelID: "fixture" },
      } as never)
      yield messageUpdated({
        id: input.assistantMessageId!,
        sessionID: sessionId,
        parentID: input.userMessageId!,
        role: "assistant",
        time: { created: 2 },
        agent: input.agent ?? "build",
        model: input.model ?? { providerID: "codex", modelID: "fixture" },
      } as never)
      yield messagePartUpdated({
        id: "prt_acp",
        sessionID: sessionId,
        messageID: input.assistantMessageId!,
        type: "text",
        text: "ACP reply",
      })
      yield sessionIdle(sessionId)
      yield { type: "finish", sessionId }
    },
    async getMessages(sessionId) {
      return [{
        info: { id: "msg_reply", sessionID: sessionId, role: "assistant" },
        parts: [],
      }]
    },
    dispose() {},
  }
}

for (const harness of [
  {
    name: "Pi",
    slug: "pi",
    runner: { type: "pi" as const },
    harnesses: undefined,
    model: { providerID: "pi", modelID: "fixture" },
    text: "exec: printf 'Pi reply'",
  },
  {
    name: "ACP",
    slug: "acp",
    runner: { type: "codex-acp" as const },
    harnesses: [{ match: () => true, create: () => acpFixture() }] satisfies WorkspaceHarnessRegistry,
    model: { providerID: "codex", modelID: "fixture" },
    text: "hello",
  },
  ...(process.env.CLAXEDO_REAL_ACP_ACCEPTANCE === "1"
    ? [{
        name: "ACP live",
        slug: "acp_live",
        runner: { type: "codex-acp" as const },
        harnesses: undefined,
        model: { providerID: "codex-acp", modelID: "default" },
        text: "Reply with exactly: ACP reply. Do not call tools.",
      }]
    : []),
]) {
  for (const route of ["message", "prompt_async"] as const) {
    test(`${harness.name} ${route} fans the admitted user message exactly once to two raw SSE clients before assistant output`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "wr-fanout-acceptance-"))
      roots.push(root)
      process.env.WORKSPACE_RUNTIME_DIRECTORY = root
      process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "ws_fanout"
      const app = new Hono()
      const host = createWorkspaceHost({
        target: { workspaceId: "ws_fanout", directory: root },
        storeFactory: () => createMemoryRuntimeStore() as never,
        ...(harness.harnesses ? { harnesses: harness.harnesses } : {}),
      })
      host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
      await host.apply({ version: 1, runner: harness.runner, auth: {}, mcp: {} })

      const sessionId = `ses_${harness.slug}_${route}`
      const created = await app.request(`http://runtime.test/session?directory=${encodeURIComponent(root)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sessionId, title: "Fan-out acceptance" }),
      })
      if (created.status !== 201) {
        throw new Error(`${harness.name} session creation failed (${created.status}): ${await created.text()}`)
      }
      expect(created.status).toBe(201)

      const clients = await Promise.all([connect(app, root), connect(app, root)])
      await Promise.all(clients.map((client) => client.until((frames) => frames.some((frame) => payload(frame)?.type === "server.connected"))))

      const messageId = `msg_${harness.slug}_${route}`
      const sent = app.request(`http://runtime.test/session/${sessionId}/${route}?directory=${encodeURIComponent(root)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageID: messageId,
          agent: "build",
          model: harness.model,
          parts: [{ type: "text", text: harness.text }],
        }),
      })
      if (route === "prompt_async") {
        const response = await sent
        expect(response.status).toBe(204)
        expect(await response.text()).toBe("")
      }

      for (const client of clients) {
        const frames = await client.until((received) => received.some(isIdle))
        const userIndexes = frames.flatMap((frame, index) => isUserMessage(frame, messageId) ? [index] : [])
        const assistantIndex = frames.findIndex(isAssistantOutput)
        expect(userIndexes).toEqual([expect.any(Number)])
        expect(assistantIndex).toBeGreaterThan(userIndexes[0]!)
        client.close()
      }

      if (route === "message") expect((await sent).status).toBe(200)
      host.dispose()
    }, harness.name === "ACP live" ? 120_000 : 20_000)
  }
}
