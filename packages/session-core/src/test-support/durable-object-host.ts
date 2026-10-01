import { Hono } from "hono"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createSessionCore } from "../core"
import { sessionEventDeliveryPolicy } from "../event-delivery"
import { storeSessionRoutes } from "../routes/session-store-reads"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { durableObjectSqliteDatabase, type DurableObjectSqlStorage } from "../sqlite/durable-object"
import { RuntimeStore } from "../store"
import { hmacChildSessionId } from "./child-identity"
import { FakeTransport, type FakeTurn } from "./fake-transport"
import { composeHost } from "./host-composition"

/** Every workspace's object serves the same synthetic directory: a Durable Object has no filesystem to tell them apart by. */
const SESSION_CORE_DIRECTORY = "/workspace"
const SESSION_CORE_WORKSPACE_HEADER = "x-workspace-id"
const EVENTS_ROUTE = "/api/wr/events"

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
 * One workspace's session core inside a Durable Object, composed from
 * `@claxedo/session-core` alone: the store over the object's own SQLite, the
 * core's routes over that store and its event stream, with a scripted harness
 * that echoes each prompt in place of a real one. Placement is a fixed
 * workspace and one synthetic directory; Pages documents and attachment bytes
 * are not supplied. It boots the way the machine runtime does after a crash:
 * the previous owner's turns are ended, then the prompts still queued are
 * re-issued.
 */
export class SessionCoreObject {
  private readonly app: Hono

  constructor(ctx: { id: { name?: string }; storage: DurableObjectSqlStorage; blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> }) {
    const workspaceId = ctx.id.name
    if (!workspaceId) throw new Error("A session core object is addressed by its workspace name")
    const directory = SESSION_CORE_DIRECTORY
    const store = new RuntimeStore({ db: durableObjectSqliteDatabase(ctx.storage), location: "durable-object", flush: () => {} })
    const host = composeHost({ store, transports: { pi: new FakeTransport({ turn: echoTurn }) }, workspaceId })
    const core = createSessionCore({
      eventHub: host.eventHub,
      placement: {
        workspaceId,
        directory,
        normalizeDirectory: (path) => path.trim(),
        canonicalDirectory: (path) => path,
        containsDirectory: (root, candidate) => candidate === root || candidate.startsWith(`${root}/`),
        sessionIdWorkspace: () => undefined,
      },
    })
    const sessionAccessPolicy = managedWorkspaceSessionAccessPolicy()
    const sessions = core.sessionRoutes(async () => host.runtime, {
      ...storeSessionRoutes({
        store: () => store,
        subagentAdmission: (parentSessionId, observation) => host.runtime.subagents.admit(parentSessionId, observation),
        deriveChildSessionId: (identity) => hmacChildSessionId(store.runtimeSecret("child-session"), identity),
        backgroundWork: (sessionId) => host.backgroundWork.read(sessionId),
      }),
      sessionAccessPolicy,
      sessionStarts: store.sessionStarts,
      requestedSessionHarness: (requested) => requested ?? { id: "pi", access: "native" },
      resolveRecoveryOwner: () => host.runtime.recovery,
    })
    const events = core.events({
      directory,
      workspaceId,
      policy: sessionEventDeliveryPolicy(sessionAccessPolicy),
      sessionAccessPolicy,
      sessionStarts: store.sessionStarts,
    })
    this.app = new Hono().get(EVENTS_ROUTE, events).route("/", sessions.routes)
    void ctx.blockConcurrencyWhile(() => {
      store.recoverBusySessions()
      return sessions.recoverQueuedPrompts()
    })
  }

  fetch(request: Request) {
    return this.app.fetch(request)
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
