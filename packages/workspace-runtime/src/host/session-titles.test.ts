import { afterEach, describe, expect, test } from "bun:test"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessSession } from "@claxedo/harness/contract"
import { sessionStatus } from "@claxedo/agent-sdk-runtime/compat-events"
import { FakeTransport } from "../test-support/fake-transport"
import { LOOPBACK_ORIGIN, createHostFixture, sessionCreate, type HostFixture } from "../test-support/host-fixture"
import { createSessionTitleOwner } from "./session-titles"

const PI: SessionHarness = { id: "pi", access: "native" }

const fixtures: HostFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})

function refusingHarness() {
  const renames: string[] = []
  const transport = new FakeTransport({
    naming: {
      generateTitle: async () => "Generated title",
      rename: async (_session: HarnessSession, title: string) => {
        renames.push(title)
        throw new Error("harness refused the title")
      },
    },
  })
  const fixture = createHostFixture({ transports: { pi: transport } })
  fixtures.push(fixture)
  return { ...fixture, renames }
}

describe("a harness that refuses a title", () => {
  test("a user rename still lands locally", async () => {
    const f = refusingHarness()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_rename", harness: PI }))
    const renamed = await f.runtime.sessions.update(id, { title: "Chosen title" })
    expect(renamed.title).toBe("Chosen title")
    expect(f.store.getSession(id)?.title).toBe("Chosen title")
    expect(f.renames).toEqual(["Chosen title"])
  })

  test("a rename or archive answers the store's own row, times included, and adds only the archive the caller named", async () => {
    const f = refusingHarness()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_times", harness: PI }))
    const renamed = await f.runtime.sessions.update(id, { title: "After" })
    expect(renamed).toEqual(f.store.getSession(id)!)
    const archived = await f.runtime.sessions.update(id, { time: { archived: 9 } })
    expect(archived.title).toBe("After")
    expect(archived.time).toEqual({ ...renamed.time, updated: archived.time.updated, archived: 9 })
    expect(archived).toEqual(f.store.getSession(id)!)
  })

  test("a generated title is still committed", async () => {
    const f = refusingHarness()
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_generated", harness: PI }))
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Plan the release" }], origin: LOOPBACK_ORIGIN })
    await f.runtime.turns.whenIdle(id)
    for (let attempt = 0; attempt < 200 && f.renames.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.renames).toEqual(["Generated title"])
    expect(f.store.getSession(id)).toMatchObject({ title: "Generated title", titleSource: "harness" })
  })
})

function sessionFrames(f: HostFixture, sessionId: string) {
  const seen: string[] = []
  f.eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "session.updated" && payload.properties.info.id === sessionId && payload.properties.info.titleSource === "harness") seen.push("title")
    if (payload.type === "session.idle" && payload.properties.sessionID === sessionId) seen.push("idle")
    if (payload.type === "session.status" && payload.properties.sessionID === sessionId) seen.push(`status:${payload.properties.status.type}`)
    if (payload.type === "message.updated" && payload.properties.info.sessionID === sessionId) seen.push(`message:${payload.properties.info.role}`)
  })
  return seen
}

function deferredTitle() {
  let answer!: (title: string) => void
  let ask!: () => void
  const asked = new Promise<void>((resolve) => { ask = resolve })
  const transport = new FakeTransport({
    naming: { generateTitle: () => { ask(); return new Promise<string>((done) => { answer = done }) } },
  })
  return { transport, asked, answer: (title: string) => answer(title) }
}

describe("a generated title", () => {
  test("never delays the idle of the turn that asked for it and follows it", async () => {
    const title = deferredTitle()
    const f = createHostFixture({ transports: { pi: title.transport } })
    fixtures.push(f)
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_title_after_idle", harness: PI }))
    const seen = sessionFrames(f, id)
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Plan the release" }], origin: LOOPBACK_ORIGIN })
    await title.asked
    expect(seen.at(-1)).toBe("idle")
    expect(seen).not.toContain("title")
    title.answer("Generated title")
    for (let attempt = 0; attempt < 200 && seen.at(-1) !== "title"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen.slice(seen.indexOf("idle"))).toEqual(["idle", "title"])
  })

  test("never delays a turn sent while it is pending, and lands whenever it answers", async () => {
    const title = deferredTitle()
    const f = createHostFixture({ transports: { pi: title.transport } })
    fixtures.push(f)
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_title_pending_next", harness: PI }))
    const seen = sessionFrames(f, id)
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Plan the release" }], origin: LOOPBACK_ORIGIN })
    await title.asked
    const firstIdle = seen.length
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Ship it" }], origin: LOOPBACK_ORIGIN })
    expect(seen.slice(firstIdle)[0]).toBe("status:busy")
    for (let attempt = 0; attempt < 200 && seen.slice(firstIdle).at(-1) !== "idle"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen.slice(firstIdle)).not.toContain("title")
    expect(seen.slice(firstIdle).at(-1)).toBe("idle")
    title.answer("Generated title")
    for (let attempt = 0; attempt < 200 && seen.at(-1) !== "title"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen.at(-1)).toBe("title")
  })
})

describe("a title side turn that never answers", () => {
  test("is dropped at its deadline and holds no other frame meanwhile", async () => {
    const f = createHostFixture({ transports: { pi: new FakeTransport() } })
    fixtures.push(f)
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_title_hangs", harness: PI }))
    const titles = createSessionTitleOwner({ store: f.store, eventHub: f.eventHub, deadlineMs: 20 })
    const attached = await f.runtime.transportFor(id)
    const seen = sessionFrames(f, id)
    const generated = titles.generate({ sessionId: id, directory: attached.session.directory,
      transport: { naming: { generateTitle: () => new Promise<string>(() => {}) } }, session: attached.session })
    f.eventHub.publishGlobal({ directory: attached.session.directory, payload: sessionStatus(id, { type: "busy" }) })
    expect(seen).toEqual(["status:busy"])
    expect(await Promise.race([generated.then(() => "dropped"), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500))]))
      .toBe("dropped")
    expect(seen).toEqual(["status:busy"])
    expect(f.store.getSession(id)?.titleSource).toBeUndefined()
  })
})
