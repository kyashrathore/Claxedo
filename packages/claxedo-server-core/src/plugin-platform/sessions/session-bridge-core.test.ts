import { describe, expect, test } from "vitest"
import type { Workspace } from "../../workspace/store/index"
import { originIds, type SessionOrigin } from "./origin-ids"
import {
  abandonOriginSession,
  createOriginSession,
  handOffToSession,
  readHandoffTranscript,
  sessionStates,
  type OriginSessionCreate,
  type SessionHost,
  type SessionRuntimeTarget,
} from "./session-bridge-core"

const WORKSPACE: Workspace = { id: "ws_1", kind: "cloud", directory: "/workspace", org_id: "org", project_id: "prj_1", created_at: 1, updated_at: 1 }
const CONFIGURATION = { harness: { id: "codex", access: "native" as const }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null }
const ORIGIN: SessionOrigin = { namespace: "plugin", key: "app-plugin:org:notes:prj_1:draft-1" }

type RuntimeSession = { config: Record<string, unknown>; messages: Array<{ info: { id: string; role: string; sessionID: string; time: { created: number } }; parts: unknown[] }>; prompts: unknown[][] }

/**
 * The workspace runtime's session routes, as much of them as an origin's
 * start, handoff and abandonment read and write. `holdCreate` keeps the next
 * create waiting until the test releases it, so two starts can race it.
 */
function runtime() {
  const sessions = new Map<string, RuntimeSession>()
  const calls: string[] = []
  let unreadable = false
  let releaseCreate: (() => void) | undefined
  let held: Promise<void> | undefined
  const target: SessionRuntimeTarget = {
    workspace: WORKSPACE,
    async request(path, init) {
      const method = init?.method ?? "GET"
      calls.push(`${method} ${path.split("?")[0]}`)
      const [, sessionId, sub] = /^\/session\/([^/?]+)(\/[a-z_]+)?/.exec(path) ?? []
      if (path.startsWith("/session/capabilities")) return Response.json({ modelSelection: { status: "optional", models: [] } })
      if (method === "POST" && path.startsWith("/session") && !sessionId) {
        await held
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { id: string; instructions?: string; model: unknown; variant?: string }
        if (sessions.has(body.id)) return Response.json({ error: { message: "taken" } }, { status: 409 })
        sessions.set(body.id, {
          config: { harness: CONFIGURATION.harness, model: body.model, ...(body.variant ? { variant: body.variant } : {}), instructions: body.instructions ?? "" },
          messages: [],
          prompts: [],
        })
        return Response.json({ id: body.id, time: { created: 1, updated: 1 } }, { status: 201 })
      }
      const session = sessionId ? sessions.get(decodeURIComponent(sessionId)) : undefined
      if (!session) return Response.json({ error: { message: "not found" } }, { status: 404 })
      if (method === "DELETE") {
        sessions.delete(decodeURIComponent(sessionId ?? ""))
        return Response.json({ ok: true })
      }
      if (sub === "/config") return Response.json(session.config)
      if (sub === "/message") return unreadable ? new Response("down", { status: 503 }) : Response.json(session.messages)
      if (sub === "/prompt_async") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { messageID: string; parts: unknown[] }
        session.messages.push({ info: { id: body.messageID, role: "user", sessionID: sessionId ?? "", time: { created: 2 } }, parts: [] })
        session.prompts.push(body.parts)
        return new Response(null, { status: 204 })
      }
      return Response.json({ id: sessionId, time: { created: 1, updated: 1 } })
    },
  }
  return {
    target,
    sessions,
    calls,
    creates: () => calls.filter((call) => call === "POST /session").length,
    holdCreate() {
      held = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
    },
    releaseCreate: () => releaseCreate?.(),
    unreadable(value: boolean) {
      unreadable = value
    },
  }
}

type Actor = { userId: string }

function host(fake: ReturnType<typeof runtime>) {
  const metas = new Map<string, { workspaceID: string }>()
  const reserved: string[] = []
  const released: string[] = []
  const reservations = new Map<string, string>()
  const port: SessionHost<Actor> = {
    target: async (workspaceId) => (workspaceId === WORKSPACE.id ? fake.target : null),
    projectTarget: async () => ({ target: fake.target }),
    sessionMetas: async (ids) => new Map(ids.flatMap((id) => (metas.has(id) ? [[id, metas.get(id)!] as const] : []))),
    reserve: async (input) => {
      reserved.push(input.operationId)
      const holder = reservations.get(input.sessionId)
      if (holder && holder !== input.operationId) return { ok: false, error: { code: "conflict", message: `Origin ${input.operationId} is reserved for another session` } }
      reservations.set(input.sessionId, input.operationId)
      return { ok: true, headers: { "x-claxedo-session-registration-operation": input.operationId } }
    },
    release: async (input) => {
      released.push(input.operationId)
      reservations.delete(input.sessionId)
    },
    projectSessionMeta: async (input) => {
      metas.set(input.sessionId, { workspaceID: input.target.workspace.id })
    },
    forgetSessionMeta: async (sessionId) => {
      metas.delete(sessionId)
    },
  }
  return { port, metas, reserved, released }
}

const ACTOR: Actor = { userId: "usr_1" }

function create(fake: ReturnType<typeof runtime>, overrides: Partial<OriginSessionCreate<Actor>> = {}): OriginSessionCreate<Actor> {
  return { actor: ACTOR, origin: ORIGIN, target: fake.target, title: "Draft", configuration: CONFIGURATION, instructions: "Write it.", configurationDigest: "digest-a", ...overrides }
}

describe("an origin's session", () => {
  test("a start is idempotent per origin: two racing starts create one session and both answer it", async () => {
    const fake = runtime()
    const { port } = host(fake)
    fake.holdCreate()
    const first = createOriginSession(port, create(fake))
    const second = createOriginSession(port, create(fake))
    await new Promise((resolve) => setTimeout(resolve, 10))
    fake.releaseCreate()
    const [one, two] = await Promise.all([first, second])
    const { sessionId } = await originIds(ORIGIN)
    expect(one).toEqual({ ok: true, session: { sessionId, workspaceId: WORKSPACE.id } })
    expect(two).toEqual(one)
    expect(fake.creates()).toBe(1)
    expect(await createOriginSession(port, create(fake))).toEqual(one)
    expect(fake.creates()).toBe(1)
  })

  test("another configuration cannot adopt the session an origin created, and another origin gets its own", async () => {
    const fake = runtime()
    const { port } = host(fake)
    expect(await createOriginSession(port, create(fake))).toMatchObject({ ok: true })
    expect(await createOriginSession(port, create(fake, { instructions: "Something else.", configurationDigest: "digest-b" }))).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    })
    const other = { namespace: "plugin", key: "app-plugin:org:notes:prj_1:draft-2" }
    const started = await createOriginSession(port, create(fake, { origin: other }))
    expect(started).toEqual({ ok: true, session: { sessionId: (await originIds(other)).sessionId, workspaceId: WORKSPACE.id } })
    expect(fake.creates()).toBe(2)
  })

  test("a handoff happens at most once: a retry finds the message and sends nothing, and an unreadable history sends nothing", async () => {
    const fake = runtime()
    const { port } = host(fake)
    const started = await createOriginSession(port, create(fake))
    if (!started.ok) throw new Error(started.error.message)
    const parts = [{ type: "text" as const, text: "Draft the release notes" }]
    expect(await handOffToSession(port, { actor: ACTOR, origin: ORIGIN, session: started.session, parts })).toEqual({ ok: true, sent: true })
    expect(await handOffToSession(port, { actor: ACTOR, origin: ORIGIN, session: started.session, parts })).toEqual({ ok: true, sent: false })
    const handed = fake.sessions.get(started.session.sessionId)
    expect(handed?.messages.map((message) => message.info.id)).toEqual([(await originIds(ORIGIN)).messageId])
    expect(handed?.prompts).toEqual([parts])

    const other = { namespace: "plugin", key: "app-plugin:org:notes:prj_1:draft-3" }
    const second = await createOriginSession(port, create(fake, { origin: other }))
    if (!second.ok) throw new Error(second.error.message)
    fake.unreadable(true)
    expect(await handOffToSession(port, { actor: ACTOR, origin: other, session: second.session, parts })).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(fake.sessions.get(second.session.sessionId)?.messages).toEqual([])
  })

  test("abandoning compensates: an unhanded session is deleted, its reservation released and its record forgotten, so the origin starts again", async () => {
    const fake = runtime()
    const { port, metas, reserved, released } = host(fake)
    const started = await createOriginSession(port, create(fake))
    if (!started.ok) throw new Error(started.error.message)
    const abandon = { actor: ACTOR, origin: ORIGIN, session: started.session, configurationDigest: "digest-a", reason: "never recorded" }
    expect(await abandonOriginSession(port, abandon)).toEqual({ ok: true, removed: true })
    expect(fake.sessions.has(started.session.sessionId)).toBe(false)
    expect(metas.has(started.session.sessionId)).toBe(false)
    expect(released).toEqual([reserved[0]])
    expect(await createOriginSession(port, create(fake, { instructions: "A fresh start.", configurationDigest: "digest-b" }))).toEqual(started)
    expect(fake.creates()).toBe(2)
  })

  test("abandoning a session its first message already reached keeps it, because it is the person's now", async () => {
    const fake = runtime()
    const { port, released } = host(fake)
    const started = await createOriginSession(port, create(fake))
    if (!started.ok) throw new Error(started.error.message)
    await handOffToSession(port, { actor: ACTOR, origin: ORIGIN, session: started.session, parts: [{ type: "text", text: "Go" }] })
    expect(await abandonOriginSession(port, { actor: ACTOR, origin: ORIGIN, session: started.session, configurationDigest: "digest-a", reason: "x" })).toEqual({ ok: true, removed: false })
    expect(fake.sessions.has(started.session.sessionId)).toBe(true)
    expect(released).toEqual([])
  })

  test("liveness and handoff are read from the session lists and the runtime, and a session nobody lists reads deleted", async () => {
    const fake = runtime()
    const { port } = host(fake)
    const started = await createOriginSession(port, create(fake))
    if (!started.ok) throw new Error(started.error.message)
    const origins = [{ origin: ORIGIN, session: started.session }, { origin: ORIGIN, session: { sessionId: "ses_unknown", workspaceId: WORKSPACE.id } }]
    expect(await sessionStates(port, origins)).toEqual([
      { session: started.session, state: "live", handoff: "pending" },
      { session: origins[1].session, state: "deleted", handoff: "unknown" },
    ])
    await handOffToSession(port, { actor: ACTOR, origin: ORIGIN, session: started.session, parts: [{ type: "text", text: "Go" }] })
    expect((await sessionStates(port, origins))[0]).toEqual({ session: started.session, state: "live", handoff: "sent" })
  })

  test("a previous session's transcript is read only while the grant asked at the read still allows it", async () => {
    const fake = runtime()
    const { port } = host(fake)
    const started = await createOriginSession(port, create(fake))
    if (!started.ok) throw new Error(started.error.message)
    await handOffToSession(port, { actor: ACTOR, origin: ORIGIN, session: started.session, parts: [{ type: "text", text: "Go" }] })
    const reads = fake.calls.length
    const refused = await readHandoffTranscript(port, { fallback: null, previous: started.session, authorize: async () => false, reader: ACTOR })
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(fake.calls.slice(reads)).toEqual([])
    const read = await readHandoffTranscript(port, { fallback: null, previous: started.session, authorize: async () => true, reader: ACTOR })
    expect(read).toMatchObject({ ok: true, handoff: { session: started.session } })
  })
})
