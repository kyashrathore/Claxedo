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
type RuntimeSession = { id: string; parentID?: string; title?: string | null }
type RuntimeMessage = { info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }

let live: LiveMcpFixture

beforeAll(async () => {
  live = await startLiveFirstPartyMcp()
}, 60_000)

afterAll(async () => {
  await live?.stop()
})

const spawn = async (client: Client, args: Record<string, unknown> = {}) =>
  toolJson<Binding>(await callTool(client, "create_subagent", { harness: "opencode", prompt: "summarise the repository", mode: "async", ...args }))

const listChildren = async (client: Client) => toolJson<ChildRow[]>(await callTool(client, "subagent_list"))

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

    const roots = (await (await live.runtimeRequest("/experimental/session?roots=true")).json()) as RuntimeSession[]
    expect(roots.map((row) => row.id)).toContain(sessionId)
    expect(roots.map((row) => row.id)).not.toContain(binding.sessionId)

    const board = toolJson<{ workspaces: Array<{ sessions?: RuntimeSession[] }> }>(await callTool(client, "sessions_list"))
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
    expect(prompts).toEqual(["Role: reviewer\n\nread the diff"])
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

    const wakes = (await readMessages(sessionId)).filter((row) => row.info.id.startsWith(`wake:${binding.sessionId}`) && row.info.role === "user")
    expect(wakes).toHaveLength(1)
    expect(wakes[0]?.parts.map((part) => part.text ?? "").join("")).toContain("opencode subagent")
  })

  test("reads one child back by session id and by subagent key once it has settled", async () => {
    const { client } = await parent("status parent")
    const binding = await spawn(client)
    await until(async () => await listChildren(client), (rows) => rows[0]?.status === "failed", "the child to reach a terminal state")

    const byKey = toolJson<Binding>(await callTool(client, "subagent_status", { subagentKey: binding.subagentKey }))
    const bySession = toolJson<Binding>(await callTool(client, "subagent_status", { sessionId: binding.sessionId }))
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

    expect(toolJson<{ canSpawn: boolean; reason?: string }>(await callTool(asChild, "subagent_capabilities")))
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

  test("reports the runtime's own harness, ceiling and wait bound to the session that may spawn", async () => {
    const { sessionId, client } = await parent("capabilities parent")

    const capabilities = toolJson<{
      canSpawn: boolean
      parentSessionId?: string
      activeChildren: number
      maxActiveChildren: number
      waitTimeoutMaxMs: number
      harnesses: Array<{ id: string; status: string }>
    }>(await callTool(client, "subagent_capabilities"))

    expect(capabilities).toMatchObject({ canSpawn: true, parentSessionId: sessionId, activeChildren: 0, maxActiveChildren: 4 })
    expect(capabilities.waitTimeoutMaxMs).toBeLessThanOrEqual(50_000)
    expect(capabilities.harnesses.map((row) => row.id)).toEqual(["claude", "codex", "cursor", "pi", "opencode"])
  })
})
