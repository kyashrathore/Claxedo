import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { sessionMeta } from "@claxedo/server-core/session/meta/index"
import { localWorkspaceRuntime } from "@claxedo/server-core/workspace/local-runtime-port"
import { hostSessionRowFromMeta } from "../session/publish/session-row"
import { callTool, startLiveFirstPartyMcp, toolJson, toolText, until, type LiveMcpFixture } from "./test-support/first-party-mcp-live"

/**
 * Which turns move a session in the list, over the composition the desktop
 * ships: the app's send through the daemon's runtime dispatch, and every turn
 * this process starts for itself through the same embedded runtime.
 *
 * The fixture configures no model, so each turn fails at the provider; the
 * human turn is recorded when the runtime admits the turn, before that.
 */

type RuntimeSession = { id: string; time?: { lastHumanTurn?: number }; lastTurn?: { status: string; assistantMessageId?: string } }
type Binding = { sessionId: string; subagentKey: string }

let live: LiveMcpFixture

beforeAll(async () => {
  live = await startLiveFirstPartyMcp()
}, 60_000)

afterAll(async () => {
  await live?.stop()
})

const readSession = async (sessionId: string) =>
  (await (await live.runtimeRequest(`/session/${sessionId}`)).json()) as RuntimeSession

const settled = (sessionId: string, assistantPrefix?: string) =>
  until(
    () => readSession(sessionId),
    (session) => session.lastTurn !== undefined && (!assistantPrefix || session.lastTurn.assistantMessageId?.startsWith(assistantPrefix) === true),
    `session ${sessionId} to settle its turn`,
  )

const promptBody = (text: string) => JSON.stringify({ parts: [{ type: "text", text }] })

/** The app's send: the daemon's runtime path for a local placement, with the capability the desktop holds. */
async function appSend(sessionId: string, text: string) {
  const url = new URL(`/session/${sessionId}/prompt_async`, `http://127.0.0.1:${live.port}`)
  url.searchParams.set("directory", live.workspace.directory)
  const response = await live.call(url, { method: "POST", headers: { "content-type": "application/json" }, body: promptBody(text) })
  expect(response.status, await response.clone().text()).toBe(204)
}

/** The rail's order: the flat list the app pages, by last human turn. */
async function listOrder(sessionIds: readonly string[]) {
  const url = new URL("/api/claxedo/session-list", `http://127.0.0.1:${live.port}`)
  url.searchParams.set("scope", "workspace")
  url.searchParams.set("directory", live.workspace.directory)
  url.searchParams.set("sort", "human_turn_desc")
  url.searchParams.set("limit", "50")
  const response = await live.call(url, { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`the navigation list answered ${response.status}`)
  const items = ((await response.json()) as { items?: Array<{ sessionId: string }> }).items ?? []
  return items.map((item) => item.sessionId).filter((id) => sessionIds.includes(id))
}

describe("a session's last human turn", () => {
  test("is the app's send, which moves its row above a newer session", async () => {
    const older = await live.createSession("older")
    const newer = await live.createSession("newer")
    expect(await until(() => listOrder([older, newer]), (ids) => ids.length === 2, "both rows to list")).toEqual([newer, older])

    await appSend(older, "pick this back up")

    const stamped = (await readSession(older)).time?.lastHumanTurn
    expect(typeof stamped).toBe("number")
    expect((await readSession(newer)).time?.lastHumanTurn).toBeUndefined()
    await until(() => listOrder([older, newer]), (ids) => ids[0] === older, "the sent-to row to move first")
    // The row a signed machine publishes to the hosted list is read off the same projection.
    const meta = await sessionMeta(older)
    expect(meta && hostSessionRowFromMeta(meta, { kind: "busy", awaitingInput: false, at: stamped ?? 0 })?.lastHumanTurnAt).toBe(stamped)
    await settled(older)
  })

  test("is not a turn an agent starts through its first-party tools, nor the wake its child sends back", async () => {
    const parent = await live.createSession("agent parent")
    const client = await live.connect(parent)

    const spawned = await callTool(client, "create_subagent", { harness: "opencode", prompt: "summarise the repository", mode: "async" })
    expect(spawned.isError, toolText(spawned)).toBeFalsy()
    const child = (toolJson(spawned) as Binding).sessionId
    const first = (await settled(child)).lastTurn?.assistantMessageId
    await settled(parent, "msg_wake_")

    const sent = await callTool(client, "session_send", { session: child, text: "keep going, child" })
    expect(sent.isError, toolText(sent)).toBeFalsy()
    await until(() => readSession(child), (session) => session.lastTurn?.assistantMessageId !== first, "the child's second turn to settle")

    for (const sessionId of [parent, child]) {
      expect((await readSession(sessionId)).time?.lastHumanTurn, sessionId).toBeUndefined()
    }
  })

  test("is not a turn this process starts through its local runtime port", async () => {
    const session = await live.createSession("task target")
    const url = new URL(`/session/${session}/prompt_async`, "http://embedded-workspace-runtime.local")
    url.searchParams.set("directory", live.workspace.directory)
    const response = await localWorkspaceRuntime().fetch(live.workspace, new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-workspace-id": live.workspace.id },
      body: promptBody("the task's first message"),
    }))
    expect(response.status, await response.clone().text()).toBe(204)
    await settled(session)

    expect((await readSession(session)).time?.lastHumanTurn).toBeUndefined()
  })
})
