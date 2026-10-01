import { Hono } from "hono"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { sessionEventDeliveryPolicy } from "../event-delivery"
import { workspaceEventsHandler } from "../routes/events"
import { WorkspaceRuntimeRoutes } from "../routes/manifest"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { durableObjectSqliteDatabase, type DurableObjectSqlStorage } from "../sqlite/durable-object"
import { RuntimeStore } from "../store"
import { withWorkspaceTarget } from "../target"
import { createWorkspaceCheckpoint } from "../workspace/checkpoint"
import { mountSessionRoutes } from "../workspace/session-routes"
import { FakeTransport, type FakeTurn } from "./fake-transport"
import { composeHost } from "./host-composition"

/** Every workspace's object serves the same synthetic directory: a Durable Object has no filesystem to tell them apart by. */
const SESSION_CORE_DIRECTORY = "/workspace"
const SESSION_CORE_WORKSPACE_HEADER = "x-workspace-id"

const HELD = "hold: "
const HOUR_MS = 3_600_000

/**
 * Echoes each prompt and finishes. A prompt starting `hold: ` instead starts
 * its answer and a tool call and then never ends, so the test can evict the
 * object while that turn is streaming.
 */
async function* echoTurn({ session, turn }: FakeTurn): AsyncIterable<AgentRuntimeEvent> {
  const text = turn.prompt.parts.map((part) => ("text" in part ? part.text : "")).join("")
  if (text.startsWith(HELD)) {
    yield { type: "text-delta", delta: `working on ${text.slice(HELD.length)}` }
    yield { type: "tool-start", toolCallId: "call_held", toolName: "bash" }
    yield { type: "tool-input", toolCallId: "call_held", input: { command: "sleep 3600" } }
    await new Promise((resolve) => setTimeout(resolve, HOUR_MS))
  }
  yield { type: "text-delta", delta: `echo: ${text}` }
  yield { type: "finish", sessionId: session.binding.sessionId }
}

/**
 * One workspace's session core inside a Durable Object: the store over the
 * object's own SQLite, the host the workspace runtime composes, the session
 * routes `mountSessionRoutes` mounts and the workspace event stream, with a
 * scripted harness that echoes each prompt in place of a real one. It boots
 * the way the machine runtime does after a crash: the previous owner's turns
 * are ended, then the prompts still queued are re-issued.
 */
export class SessionCoreObject {
  private readonly app: Hono
  private readonly target: { workspaceId: string; directory: string }

  constructor(ctx: { id: { name?: string }; storage: DurableObjectSqlStorage; blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> }) {
    const workspaceId = ctx.id.name
    if (!workspaceId) throw new Error("A session core object is addressed by its workspace name")
    const directory = SESSION_CORE_DIRECTORY
    this.target = { workspaceId, directory }
    const store = new RuntimeStore({ db: durableObjectSqliteDatabase(ctx.storage), location: "durable-object", flush: () => {} })
    const host = composeHost({ store, transports: { pi: new FakeTransport({ turn: echoTurn }) }, workspaceId })
    const sessionAccessPolicy = managedWorkspaceSessionAccessPolicy()
    const bus = createBus<WorkspaceRuntimeEvent>()
    const sessions = mountSessionRoutes({
      runtime: async () => host.runtime,
      recovery: () => host.runtime.recovery,
      store: () => store,
      sessionStarts: store.sessionStarts,
      eventHub: host.eventHub,
      bus,
      sessionAccessPolicy,
      checkpoint: createWorkspaceCheckpoint({
        recovery: () => host.runtime.recovery,
        turnStarted: () => {},
        turnEnded: () => {},
        onActivityChange: () => {},
      }),
      currentRunner: () => ({ id: "pi", access: "native" }),
      sessionToolPrompt: () => undefined,
      subagentAdmission: (parentSessionId, observation) => host.runtime.subagents.admit(parentSessionId, observation),
      backgroundWork: (sessionId) => host.backgroundWork.read(sessionId),
    })
    const events = workspaceEventsHandler({
      directory,
      workspaceId,
      eventHub: host.eventHub,
      bus,
      policy: sessionEventDeliveryPolicy(sessionAccessPolicy),
      sessionAccessPolicy,
      sessionStarts: store.sessionStarts,
    })
    this.app = new Hono().get(WorkspaceRuntimeRoutes.events, events).route("/", sessions.routes)
    void ctx.blockConcurrencyWhile(() => withWorkspaceTarget(this.target, () => {
      store.recoverBusySessions()
      return sessions.recoverQueuedPrompts()
    }))
  }

  fetch(request: Request) {
    return withWorkspaceTarget(this.target, () => this.app.fetch(request))
  }
}

type Env = {
  SESSION_CORE: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
}

export default {
  fetch(request: Request, env: Env) {
    const workspaceId = request.headers.get(SESSION_CORE_WORKSPACE_HEADER)
    if (!workspaceId) return new Response(`${SESSION_CORE_WORKSPACE_HEADER} is required`, { status: 400 })
    return env.SESSION_CORE.get(env.SESSION_CORE.idFromName(workspaceId)).fetch(request)
  },
}
