import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test, type AcpStep } from "../harness"
import {
  expectRailEqualsServer,
  expectServerStatus,
  holdListRead,
  loadEveryPage,
  PAGE_SIZE,
  patchSession,
  railLinks,
  railRows,
  reopenHoldingListRead,
  serverItems,
  setup,
  startHeldTurn,
  STREAM_PATH,
  watchBrowserStream,
} from "./31-session-list-races.oracle"

test.skip(({ isMobile }) => isMobile, "Flow 31 runs at desktop width; flow 33 owns the phone rail")

test("31 an event arrives before the list response", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race quiet", "Race renamed", "Race working", "Race fence"])
  const [, renamed, working, fence] = sessions
  const stream = await watchBrowserStream(app)
  const read = await reopenHoldingListRead(app, stack)
  await patchSession(checked, renamed.id, { title: "Race renamed during the read" })
  await startHeldTurn(checked, working.id, "working-during-read")
  await expectServerStatus(checked, working.id, "Working")
  await patchSession(checked, fence.id, { title: "Race fence one" })
  await stream.received("Race fence one")
  await read.release()
  await expectRailEqualsServer(app, checked)
})

test("31 a delete lands during a fetch", async ({ stack, api, app }) => {
  const { checked } = await setup(stack, api, app, Array.from({ length: PAGE_SIZE + 5 }, (_, index) => `Race row ${index}`))
  const order = (await serverItems(stack)).map((item) => item.sessionId)
  const stream = await watchBrowserStream(app)
  const first = await reopenHoldingListRead(app, stack)
  await api.deleteSession(checked.directory, order[1])
  await patchSession(checked, order[2], { title: "Race fence first page" })
  await stream.received("Race fence first page")
  await first.release()
  await expectRailEqualsServer(app, checked)
  const more = await holdListRead(app, (url) => url.searchParams.has("cursor"))
  await app.getByRole("button", { name: "Load more" }).click()
  await more.computed
  await api.deleteSession(checked.directory, order[3])
  await api.deleteSession(checked.directory, order[PAGE_SIZE + 2])
  await patchSession(checked, order[4], { title: "Race fence second page" })
  await stream.received("Race fence second page")
  await more.release()
  await expectRailEqualsServer(app, checked, { through: order[PAGE_SIZE + 4] })
})

test("31 another browser creates a session", async ({ stack, api, app, browser }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race first", "Race second"])
  await expectRailEqualsServer(app, checked)
  const other = await (await browser.newContext()).newPage()
  await other.goto(`${stack.url}/`)
  await railLinks(other).filter({ hasText: sessions[0].title }).click()
  await other.getByRole("button", { name: "New session" }).click()
  await expect.poll(async () => (await serverItems(stack)).length, { message: "the server lists the new session" }).toBe(3)
  await expectRailEqualsServer(app, checked)
  await expectRailEqualsServer(other, checked)
  await other.context().close()
})

test("31 the app reconnects after missed events", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race kept", "Race gone", "Race retitled", "Race prompted"])
  await expectRailEqualsServer(app, checked)
  const isStream = (url: URL) => url.pathname.endsWith(STREAM_PATH)
  await app.route(isStream, (route) => route.abort())
  await stack.daemon.restart()
  await api.deleteSession(checked.directory, sessions[1].id)
  await patchSession(checked, sessions[2].id, { title: "Race retitled while away" })
  await stack.acp.write("away", { steps: [{ kind: "text", text: "Answered while away" }] })
  await api.prompt(checked.directory, sessions[3].id, `Hello ${acpScriptToken("away")}`)
  await api.createSession(checked.directory, { title: "Race created while away", harness: SCRIPTED_ACP_HARNESS })
  await app.unroute(isStream)
  await expectRailEqualsServer(app, checked, { timeout: 30_000 })
})

test("31 statuses follow the turn: working, waiting on you, working, idle, and failed", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race lifecycle", "Race failing"])
  const [lifecycle, failing] = sessions
  await expectRailEqualsServer(app, checked)
  const permission: AcpStep = { kind: "permission", tool: "edit", title: "Edit the notes", path: `${checked.directory}/notes.md` }
  await startHeldTurn(checked, lifecycle.id, "lifecycle", [permission, { kind: "hold", name: "after-permission" }])
  const expectStep = async (label: string) => {
    await expectServerStatus(checked, lifecycle.id, label)
    await expectRailEqualsServer(app, checked)
  }
  await expectStep("Working")
  await stack.acp.release("lifecycle")
  await expectStep("Waiting on you")
  const [request] = await api.permissions(checked.directory)
  await api.replyPermission(checked.directory, lifecycle.id, request.id, "once")
  await expectStep("Working")
  await stack.acp.release("after-permission")
  await expectStep("Idle")
  await stack.acp.write("failing", { steps: [{ kind: "error", message: "Scripted turn failure" }] })
  await api.promptAsync(checked.directory, failing.id, `Fail ${acpScriptToken("failing")}`)
  await expectServerStatus(checked, failing.id, "Failed")
  await expectRailEqualsServer(app, checked)
})

test("31 a session is archived, renamed or deleted while a turn runs", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race archive me", "Race rename me", "Race delete me", "Race bystander"])
  const [archived, renamed, deleted] = sessions
  const holds = ["archive-turn", "rename-turn", "delete-turn"]
  for (const [index, hold] of holds.entries()) await startHeldTurn(checked, sessions[index].id, hold)
  for (const session of [archived, renamed, deleted]) await expectServerStatus(checked, session.id, "Working")
  await expectRailEqualsServer(app, checked)
  await patchSession(checked, archived.id, { time: { archived: Date.now() } })
  await patchSession(checked, renamed.id, { title: "Race renamed mid-turn" })
  await expect(api.deleteSession(checked.directory, deleted.id), "the server refuses to delete running work").rejects.toMatchObject({ status: 409 })
  await expectRailEqualsServer(app, checked)
  for (const hold of holds) await stack.acp.release(hold)
  await expectServerStatus(checked, deleted.id, "Idle")
  await api.deleteSession(checked.directory, deleted.id)
  await expectServerStatus(checked, renamed.id, "Idle")
  await expectRailEqualsServer(app, checked)
})

test("31 a thousand sessions, including the status of rows off screen", async ({ stack, api, app }) => {
  test.setTimeout(180_000)
  const titles = Array.from({ length: 1000 }, (_, index) => `Bulk ${String(index).padStart(4, "0")}`)
  const { sessions, checked } = await setup(stack, api, app, titles)
  const oldest = sessions[0]
  await startHeldTurn(checked, oldest.id, "off-screen")
  await expectServerStatus(checked, oldest.id, "Working")
  await expectRailEqualsServer(app, checked)
  await loadEveryPage(app)
  await expectRailEqualsServer(app, checked, { through: oldest.id, timeout: 60_000 })
  expect((await railRows(app)).at(-1), "the last row, off screen until scrolled, shows the server's status").toEqual({
    sessionId: oldest.id,
    title: oldest.title,
    status: "Working",
  })
})
