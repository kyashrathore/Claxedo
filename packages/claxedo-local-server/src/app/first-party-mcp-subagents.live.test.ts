import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  callTool,
  startLiveFirstPartyMcp,
  toolJson,
  toolText,
  until,
  type LiveMcpFixture,
} from "./test-support/first-party-mcp-live"

/**
 * `create_subagent` and the rest of the subagent tools driven over a real MCP
 * client against the runtime that actually owns child sessions: the real
 * `SessionRoutes`, the real `createChildSessionHost`, the real store and the
 * real `opencode` adapter, reached through the entry the runtime injected into
 * the parent session.
 *
 * `packages/claxedo-mcp/src/tools/subagents.test.ts` mounts the same tools over
 * a hand-written runtime, because the route module needs an adapter and a store
 * that package does not depend on. That fixture answered `GET /session/:id/message`
 * with a `{ messages }` envelope the real route has never sent, and every
 * subagent read that reached a settled child threw against the real one.
 *
 * The child's turn fails here — the fixture machine configures no model — so
 * what these tests read is the runtime's own terminal-state, wake and summary
 * handling for a child that finished badly, which is the same path a child that
 * finishes well takes.
 */

type Binding = { kind: string; subagentKey: string; sessionId: string; status?: string; summary?: string }
type ChildRow = { subagentKey: string; sessionId: string; status?: string; label?: string; role?: string; wake?: string }
type TurnOutcome = { status: string; error?: string; assistantMessageId?: string }
type RuntimeSession = { id: string; parentID?: string; title?: string | null; lastTurn?: TurnOutcome }
type MessageError = { name: string; data?: { message?: string; firstTurnErrorClass?: string } }
type RuntimeMessage = { info: { id: string; role: string; error?: MessageError }; parts: Array<{ type: string; text?: string }> }

let live: LiveMcpFixture

beforeAll(async () => {
  live = await startLiveFirstPartyMcp()
}, 60_000)

afterAll(async () => {
  await live?.stop()
})

const spawn = async (client: Client, args: Record<string, unknown> = {}) =>
  (toolJson(await callTool(client, "create_subagent", { harness: "opencode", prompt: "summarise the repository", mode: "async", ...args })) as Binding)

const listChildren = async (client: Client) => (toolJson(await callTool(client, "subagent_list")) as ChildRow[])

const readSession = async (sessionId: string) =>
  (await (await live.runtimeRequest(`/session/${sessionId}`)).json()) as RuntimeSession

const readMessages = async (sessionId: string) =>
  (await (await live.runtimeRequest(`/session/${sessionId}/message`)).json()) as RuntimeMessage[]

async function parent(title: string) {
  const sessionId = await live.createSession(title)
  return { sessionId, client: await live.connect(sessionId) }
}

describe("a subagent started over the injected first-party MCP", () => {
  test("is a real child of the caller that no root listing and no sessions_list ever shows", async () => {
    const { sessionId, client } = await parent("subagent parent")

    const binding = await spawn(client)
    expect(binding).toMatchObject({ kind: "claxedo.subagent", subagentKey: expect.stringMatching(/^subagent_/), sessionId: expect.any(String) })
    expect(binding.sessionId).not.toBe(sessionId)

    expect(await readSession(binding.sessionId)).toMatchObject({ id: binding.sessionId, parentID: sessionId })

    for (const route of ["/session?roots=true", "/experimental/session?roots=true"]) {
      const rows = (await (await live.runtimeRequest(route)).json()) as RuntimeSession[]
      expect(rows.map((row) => row.id), route).toContain(sessionId)
      expect(rows.map((row) => row.id), route).not.toContain(binding.sessionId)
    }

    const inventory = await live.rootInventory()
    expect(inventory.map((row) => row.sessionID)).toContain(sessionId)
    expect(inventory.map((row) => row.sessionID)).not.toContain(binding.sessionId)

    // Every root the flat inventory holds and no other row: a navigation list
    // that merely omitted the child could equally have dropped a root, and the
    // rail renders from this list alone.
    const navigation = await live.navigationRows()
    expect(navigation.map((row) => row.sessionId).sort())
      .toEqual(inventory.map((row) => row.sessionID).sort())

    const board = (toolJson(await callTool(client, "sessions_list")) as { workspaces: Array<{ sessions?: RuntimeSession[] }> })
    const listed = board.workspaces.flatMap((row) => row.sessions ?? []).map((row) => row.id)
    expect(listed).toContain(sessionId)
    expect(listed).not.toContain(binding.sessionId)
  })

  test("carries the role line into the child's first turn and copies no parent history", async () => {
    const { sessionId, client } = await parent("role parent")
    await callTool(client, "session_send", { session: sessionId, text: "a secret the child must never see" })

    const binding = await spawn(client, { role: "reviewer", prompt: "read the diff" })

    const childTurns = await readMessages(binding.sessionId)
    const prompts = childTurns.filter((row) => row.info.role === "user").flatMap((row) => row.parts.map((part) => part.text ?? ""))
    // The embedded harness has no instruction channel, so the child's
    // standing block rides at the head of this one prompt instead.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.endsWith("\n\nRole: reviewer\n\nread the diff")).toBe(true)
    expect(prompts[0]).toContain("cannot start subagents of your own")
    expect(prompts.join("")).not.toContain("a secret the child must never see")
  })

  test("wakes its idle parent exactly once when it finishes, with the child's own outcome", async () => {
    const { sessionId, client } = await parent("wake parent")
    const binding = await spawn(client)

    const [settled] = await until(
      async () => (await listChildren(client)).filter((row) => row.subagentKey === binding.subagentKey),
      (rows) => rows[0]?.wake === "delivered",
      "the runtime to deliver the child's wake to its parent",
    )
    expect(settled?.status).toBe("failed")

    const wakes = (await readMessages(sessionId)).filter((row) => row.info.id.startsWith(`msg_wake_${binding.sessionId}`) && row.info.role === "user")
    expect(wakes).toHaveLength(1)
    const summary = wakes[0]?.parts.map((part) => part.text ?? "").join("") ?? ""
    expect(summary).toContain("opencode subagent")
    // The summary is the child's own outcome, so it also reports whether the
    // child's first turn was admitted: `create_subagent` prompts it under a
    // derived id the engine has to accept.
    expect(summary).not.toContain('starting with "msg_"')

    // The wake turn has to be ADMITTED, not merely offered, and the user
    // message above cannot say which: the runtime store publishes it before the
    // engine ever sees the id, so a wake the engine refuses looks identical
    // here. The parent's own outcome is the only witness. This fixture
    // configures no model, so the furthest an admitted turn gets is the
    // provider route, and that is what its error class has to say.
    const wakeTurn = await until(
      async () => (await readSession(sessionId)).lastTurn,
      (turn) => turn?.assistantMessageId?.startsWith("msg_wake_") === true,
      "the parent's wake turn to settle",
    )
    expect(wakeTurn?.error ?? "").not.toContain('starting with "msg_"')
    const reply = (await readMessages(sessionId)).find((row) => row.info.id === wakeTurn?.assistantMessageId)
    expect(reply?.info.error?.data?.firstTurnErrorClass).toBe("model")
  })

  test("reads one child back by session id and by subagent key once it has settled", async () => {
    const { client } = await parent("status parent")
    const binding = await spawn(client)
    await until(async () => await listChildren(client), (rows) => rows[0]?.status === "failed", "the child to reach a terminal state")

    const byKey = (toolJson(await callTool(client, "subagent_status", { subagentKey: binding.subagentKey })) as Binding)
    const bySession = (toolJson(await callTool(client, "subagent_status", { sessionId: binding.sessionId })) as Binding)
    expect(byKey).toMatchObject({ subagentKey: binding.subagentKey, sessionId: binding.sessionId, status: "failed" })
    expect(bySession).toEqual(byKey)
  })

  test("answers a retried clientRequestId with the same child instead of starting another", async () => {
    const { client } = await parent("idempotent parent")

    const first = await spawn(client, { clientRequestId: "retry-me" })
    const second = await spawn(client, { clientRequestId: "retry-me" })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.subagentKey).toBe(first.subagentKey)

    const rows = await listChildren(client)
    expect(rows.filter((row) => row.sessionId === first.sessionId)).toHaveLength(1)
    expect(rows).toHaveLength(1)
  })

  test("refuses a child that would start a child of its own", async () => {
    const { client } = await parent("recursion parent")
    const binding = await spawn(client)

    const asChild = await live.connect(binding.sessionId)
    const refused = await callTool(asChild, "create_subagent", { harness: "opencode", prompt: "delegate again", mode: "async" })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toContain("subagent_recursion_denied")

    expect((toolJson(await callTool(asChild, "subagent_capabilities")) as { canSpawn: boolean; reason?: string }))
      .toMatchObject({ canSpawn: false, reason: expect.stringContaining("subagent") })
  })

  test("serves each caller only its own children, and refuses to read or cancel any other session", async () => {
    const mine = await parent("owner parent")
    const theirs = await parent("other parent")
    const own = await spawn(mine.client)
    const other = await spawn(theirs.client)

    expect((await listChildren(mine.client)).map((row) => row.sessionId)).toEqual([own.sessionId])
    expect((await listChildren(theirs.client)).map((row) => row.sessionId)).toEqual([other.sessionId])

    for (const tool of ["subagent_status", "subagent_cancel"]) {
      const refused = await callTool(mine.client, tool, { sessionId: other.sessionId })
      expect(refused.isError, `${tool} answered a session that is not the caller's child`).toBe(true)
      expect(toolText(refused)).toContain("is not a child of this session")
    }
    const refusedParent = await callTool(mine.client, "subagent_cancel", { sessionId: mine.sessionId })
    expect(refusedParent.isError).toBe(true)
  })

  test("reports the ceiling, wait bound and harness list to the session that may spawn", async () => {
    const { sessionId, client } = await parent("capabilities parent")

    const capabilities = (toolJson(await callTool(client, "subagent_capabilities")) as {
      canSpawn: boolean
      parentSessionId?: string
      activeChildren: number
      maxActiveChildren: number
      waitTimeoutMaxMs: number
      harnesses: Array<{ id: string; status: string; reason?: string }>
    })

    expect(capabilities).toMatchObject({ canSpawn: true, parentSessionId: sessionId, activeChildren: 0, maxActiveChildren: 4 })
    expect(capabilities.waitTimeoutMaxMs).toBeLessThanOrEqual(50_000)
    expect(capabilities.harnesses.map((row) => row.id)).toEqual(["claude", "codex", "cursor", "pi", "opencode"])
  })

  test("answers what this runtime can spawn when it declares no default harness", async () => {
    const { client } = await parent("unconfigured harness parent")

    const direct = await live.runtimeRequest("/session/capabilities")
    expect(direct.status).toBe(409)
    expect(await direct.json()).toMatchObject({ error: { code: "workspace_harness_not_configured" } })

    const answered = await callTool(client, "subagent_capabilities")
    expect(answered.isError).toBeFalsy()
    const capabilities = toolJson(answered) as { canSpawn: boolean; runtimeHarness?: string; harnesses: Array<{ id: string; status: string; reason?: string }> }
    expect(capabilities.canSpawn).toBe(true)
    expect(capabilities.runtimeHarness).toBeUndefined()
    expect(capabilities.harnesses.every((row) => row.status === "unverified")).toBe(true)
    expect(capabilities.harnesses[0]?.reason).toContain("No default harness is configured on this runtime")

    const spawned = await spawn(client)
    expect(spawned.sessionId).toEqual(expect.any(String))
  })
})
