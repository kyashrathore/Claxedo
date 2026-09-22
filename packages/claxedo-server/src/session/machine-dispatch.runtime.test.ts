import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-sdk-runtime"
import { createAgentRuntime } from "../../../agent-sdk-runtime/src/runtime"
import type { AgentHarnessAdapter } from "../../../agent-sdk-runtime/src/adapter-contract"
import { createMemoryRuntimeStore } from "../../../agent-sdk-runtime/src/stores/memory"
import {
  buildAssistantMessage,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  sessionIdle,
} from "../../../agent-sdk-runtime/src/compat-events"
import { createSessionRoutes } from "../../../workspace-runtime/src/routes/session-core"
import { workspaceEventsHandler } from "../../../workspace-runtime/src/routes/events"
import { createRuntimeEventHub } from "../../../workspace-runtime/src/runtime-event-hub"
import { createBus, type WorkspaceRuntimeEvent } from "../../../workspace-runtime/src/bus"
import { configureLocalWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"
import { createMachineSessionDispatch } from "./machine-dispatch"
import type { ControlPlaneServices } from "../authority/services"

const workspace = { id: "ws_machine", kind: "local", directory: "/workspace", org_id: "org" }

vi.mock("@claxedo/server-core/workspace/store/index", () => ({
  resolveWorkspace: async ({ workspaceId }: { workspaceId: string }) => (workspaceId === "ws_machine" ? workspace : undefined),
}))

function adapterFixture() {
  const sessions = new Map<string, { id: string; title: string; time: { created: number; updated: number } }>()
  const adapter: AgentHarnessAdapter = {
    async getSession(execution) {
      return sessions.get(execution.sessionId) ?? null
    },
    async createSession(_directory, title, id) {
      const session = { id: id ?? "ses_machine", title: title ?? "Machine", time: { created: 1, updated: 1 } }
      sessions.set(session.id, session)
      return session
    },
    async updateSession(execution) {
      return sessions.get(execution.sessionId) ?? null
    },
    async deleteSession(execution) {
      sessions.delete(execution.sessionId)
    },
    async getSessionConfig() {
      return { harness: { id: "pi", access: "native" }, agent: "build", variant: null }
    },
    async updateSessionConfig() {
      return { harness: { id: "pi", access: "native" }, agent: "build", variant: null }
    },
    instructionChannel: "none" as const,
    readHarnessCapabilities() {
      return {
        harness: "pi", abort: false, reconnect: true, replay: true, permissions: false, questions: false,
        todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: false,
        subagents: false, goals: false, effortLevels: NO_HARNESS_EFFORT, instructionChannel: "none" as const,
      }
    },
    async *executeTurn(execution, input) {
      const sessionId = execution.sessionId
      const user = buildUserMessage({ id: input.userMessageId!, sessionID: sessionId, agent: input.agent, model: input.model })
      const assistant = buildAssistantMessage({
        id: input.assistantMessageId, sessionID: sessionId, parentID: input.userMessageId!,
        agent: input.agent, model: input.model, directory: "/workspace",
      })
      yield messageUpdated(user)
      yield messageUpdated(assistant)
      yield messagePartUpdated({
        id: `${input.assistantMessageId}-text`, sessionID: sessionId, messageID: input.assistantMessageId,
        type: "text" as const, text: "machine reply",
      })
      yield sessionIdle(sessionId)
      yield { type: "finish", sessionId }
    },
    async getMessages() {
      return []
    },
    dispose() {},
  }
  return adapter
}

afterEach(() => {
  configureLocalWorkspaceRuntime(undefined)
})

describe("machine dispatch against the workspace runtime it reads", () => {
  test("a dispatched prompt's turn is read off wr/events, session-scoped, through the embedded runtime", async () => {
    const adapter = adapterFixture()
    const hub = createRuntimeEventHub()
    const runtime = createAgentRuntime({
      store: createMemoryRuntimeStore(),
      harnesses: [{ id: "pi", access: "native", create: () => adapter } as never],
      eventHub: hub,
    })
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = new Hono()
    app.route("/", createSessionRoutes({
      resolveAdapter: () => adapter,
      resolveRuntime: () => runtime,
      resolveDirectory: () => "/workspace",
      listSessions: () => runtime.sessions.list("/workspace"),
      createSession: (_c, directory, title, id) => runtime.sessions.create({
        id, workspaceId: "ws_machine", directory, title, harness: { id: "pi", access: "native" },
      }),
      getSession: (_c, directory, sessionId) => runtime.sessions.get(sessionId, directory),
      getMessages: () => adapter.getMessages({} as never),
      publishGlobal: (event) => hub.publishGlobal(event),
    }))
    const events = workspaceEventsHandler({ directory: "/workspace", eventHub: hub, bus })
    app.get("/api/wr/events", events)
    configureLocalWorkspaceRuntime({
      fetch: async (_ws, request) => await app.fetch(request),
      sessionAuthority: () => "local",
    })

    const services = {
      projectionStore: {
        session_meta: async () => ({ host: "workspace", workspaceID: "ws_machine" }),
        put_session_meta: async () => {},
      },
    } as unknown as ControlPlaneServices
    const dispatch = createMachineSessionDispatch(services, {})
    const session = await dispatch.create({ workspaceId: "ws_machine" })
    expect(session.id).toBe("ses_machine")

    const seen: Array<{ type: string; properties?: { part?: { text?: string } } }> = []
    for await (const event of dispatch.prompt("ses_machine", { messageID: "msg_machine", parts: [{ type: "text", text: "hi" }] })) {
      seen.push(event as (typeof seen)[number])
    }
    expect(seen.map((event) => event.type)).toContain("message.updated")
    expect(seen.some((event) => event.type === "message.part.updated" && event.properties?.part?.text === "machine reply")).toBe(true)
    expect(seen.at(-1)?.type).toBe("session.idle")
    events.close()
  })
})
