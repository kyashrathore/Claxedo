import { expect, test } from "bun:test"
import type { OutsideTurnEvent, SessionBroker } from "../../contract"
import { scriptedPi } from "./test-support/scripted-pi"

test("Pi's echo of a rename Claxedo sent is not a title Pi chose, and a name Pi sets itself still is", async () => {
  const pi = await scriptedPi()
  try {
    const published: OutsideTurnEvent[] = []
    const session = await pi.transport.start(pi.start(), { ...pi.broker, publish: async (event: OutsideTurnEvent) => { published.push(event) } })
    await pi.transport.naming.rename(session, "Renamed by the person")
    pi.launches[0]!.wire.send({ type: "session_info_changed", name: "Named by Pi" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(published.flatMap((event) => event.type === "session-title" ? [event.title] : [])).toEqual(["Named by Pi"])
  } finally { await pi.close() }
})

test("Pi names a session whenever the runtime asks, even while a run Pi started is in flight", async () => {
  const pi = await scriptedPi()
  try {
    const session = await pi.transport.start(pi.start(), { ...pi.broker, admitProviderTurn: () => new Promise(() => {}) } as SessionBroker)
    pi.launches[0]!.wire.send({ type: "agent_start" })
    const title = await pi.transport.naming.generateTitle(session, { directory: pi.directory, system: "Name it", user: "Hello",
      signal: new AbortController().signal })
    expect(title).toBe("Scripted title")
  } finally { await pi.close() }
})
