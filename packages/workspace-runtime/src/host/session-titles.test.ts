import { afterEach, describe, expect, test } from "bun:test"
import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { HarnessSession } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { LOOPBACK_ORIGIN, createHostFixture, sessionCreate, type HostFixture } from "../test-support/host-fixture"

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
