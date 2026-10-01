import { expect, test } from "bun:test"
import { entryHome, hashes, OWNER_KEY, ownLoginContext, type CodexBackend } from "../../e2e/harness/codex-conformance"
import type { PluginProjection, ResolvedCredentials } from "../contract"

type Context = Awaited<ReturnType<typeof ownLoginContext>>["context"]

async function reply(context: Context, marker: string) {
  const text: string[] = []
  for await (const routed of context.transport.send(context.session, context.turn(`Reply with exactly this one token: ${marker}`), context.turnBroker())) {
    if (routed.event.type === "text-delta") text.push(routed.event.delta)
  }
  const request = (context.backend as CodexBackend).server.requests.find((row) => row.prompt.includes(marker))
  return { text: text.join(""), prompt: request?.prompt ?? "", authorization: request?.authorization ?? "" }
}

test("a Codex session keeps its thread and goal when its plugin selection mode and then its account switch, and back again", async () => {
  const { context, ownerHome } = await ownLoginContext("codex-shared-sessions")
  try {
    const state = context.backend as CodexBackend
    const before = await hashes(ownerHome)
    const ownLogin = context.start.credentials
    const brokered: ResolvedCredentials = { ...ownLogin, providers: { openai: { baseUrl: state.server.v1Url, placeholder: "switched-account", authMode: "api-key" } } }
    const selected: PluginProjection = { ...context.start.projection, generation: "g2", pluginSelection: { mode: "selected", selectionHash: "one" } }
    const first = await reply(context, "OWNLOGIN")
    expect(first.authorization).toContain(OWNER_KEY)
    const ownHome = entryHome(context.transport, "s1")
    const started = await context.transport.goals!.start(context.session, "Reply with exactly this one token: GOALKEPT", context.sessionBroker)
    expect(started.ok).toBe(true)
    expect((await context.transport.goals!.pause(context.session)).ok).toBe(true)

    expect(await context.transport.configure(context.session, { projection: selected })).toEqual({ state: "applied" })
    const selectedHome = entryHome(context.transport, "s1")
    expect(selectedHome).not.toBe(ownHome)
    const afterMode = await reply(context, "SELECTEDMODE")
    expect(afterMode.text).toContain("SELECTEDMODE")
    expect(afterMode.prompt).toContain("OWNLOGIN")
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ objective: "Reply with exactly this one token: GOALKEPT", status: "paused" })

    expect(await context.transport.configure(context.session, { credentials: brokered })).toEqual({ state: "applied" })
    expect([ownHome, selectedHome]).not.toContain(entryHome(context.transport, "s1"))
    const afterAccount = await reply(context, "STOREDACCOUNT")
    expect(afterAccount.text).toContain("STOREDACCOUNT")
    expect(afterAccount.prompt).toContain("OWNLOGIN")
    expect(afterAccount.prompt).toContain("SELECTEDMODE")
    expect(afterAccount.authorization).toContain("switched-account")
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ objective: "Reply with exactly this one token: GOALKEPT", status: "paused" })

    expect(await context.transport.configure(context.session, { credentials: ownLogin, projection: { ...context.start.projection, generation: "g3" } })).toEqual({ state: "applied" })
    expect(entryHome(context.transport, "s1")).toBe(ownHome)
    const back = await reply(context, "BACKHOME")
    expect(back.text).toContain("BACKHOME")
    expect(back.prompt).toContain("STOREDACCOUNT")
    expect(back.authorization).toContain(OWNER_KEY)
    expect(await context.transport.goals!.read(context.session)).toMatchObject({ objective: "Reply with exactly this one token: GOALKEPT", status: "paused" })
    expect(await hashes(ownerHome)).toEqual(before)
  } finally { await context.close() }
}, 180_000)
