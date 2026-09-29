import { afterEach, describe, expect, test } from "bun:test"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessSession } from "@claxedo/harness/contract"
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

describe("a generated title", () => {
  test("lands before the turn that asked for it is idle", async () => {
    const transport = new FakeTransport({
      naming: { generateTitle: () => new Promise((resolve) => setTimeout(() => resolve("Generated title"), 20)) },
    })
    const f = createHostFixture({ transports: { pi: transport } })
    fixtures.push(f)
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_title_order", harness: PI }))
    const seen: string[] = []
    const idle = new Promise<string[]>((resolve) => {
      f.eventHub.subscribeGlobal(({ payload }) => {
        if (payload.type === "session.updated" && payload.properties.info.titleSource === "harness") seen.push("title")
        if (payload.type === "session.idle" && payload.properties.sessionID === id) resolve([...seen, "idle"])
      })
    })
    await f.runtime.turns.start({ sessionId: id, parts: [{ type: "text", text: "Plan the release" }], origin: LOOPBACK_ORIGIN })
    expect(await idle).toEqual(["title", "idle"])
  })
})

describe("a title side turn that never answers", () => {
  test("is abandoned at its deadline, so it cannot hold the turn that asked for it", async () => {
    const f = createHostFixture({ transports: { pi: new FakeTransport() } })
    fixtures.push(f)
    const { id } = await f.runtime.sessions.create(sessionCreate({ id: "ses_title_hangs", harness: PI }))
    const titles = createSessionTitleOwner({ store: f.store, eventHub: f.eventHub, deadlineMs: 20 })
    const attached = await f.runtime.transportFor(id)
    const generated = titles.generate({ sessionId: id, directory: attached.session.directory,
      transport: { naming: { generateTitle: () => new Promise<string>(() => {}) } }, session: attached.session })
    expect(await Promise.race([generated.then(() => "abandoned"), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500))]))
      .toBe("abandoned")
    expect(f.store.getSession(id)?.titleSource).toBeUndefined()
  })
})
