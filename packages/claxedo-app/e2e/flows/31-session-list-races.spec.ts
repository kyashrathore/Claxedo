import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, sendPrompt, sessionRoute, UI, type AcpStep } from "../harness"
import {
  holdEventStreams,
  holdListRead,
  patchSession,
  reopenHoldingListRead,
  setup,
  startHeldTurn,
  test,
  watchBrowserStream,
} from "./31-session-list-races.controls"
import {
  caseOrder,
  expectRailEqualsServer,
  expectServerStatus,
  loadPagesUntil,
  PAGE_SIZE,
  railRow,
} from "./31-session-list-races.oracle"
import { activityRow, expectInventoryMatchesServer, readerRow, writeReader } from "./31-session-list-races.reader"
import { sidebarFilter } from "../harness/sidebar-filter"

test.skip(({ isMobile }) => isMobile, "Flow 31 runs at desktop width; flow 33 owns the phone rail")

test("31 an event arrives before the list response", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race quiet", "Race renamed", "Race working", "Race fence"], { open: false })
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
  await stack.acp.release("working-during-read")
})

test("31 a row and its status land together, from the list read alone", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race painted", "Race busy"], { open: false })
  const [, busy] = sessions
  await startHeldTurn(checked, busy.id, "busy-before-open")
  await expectServerStatus(checked, busy.id, "Working")
  await app.goto("about:blank")
  const list = await holdListRead(app)
  const statusReads: string[] = []
  app.on("request", (request) => {
    if (/\/session\/status(\?|$)|\/permission(\?|$)|\/question(\?|$)/.test(request.url())) statusReads.push(request.url())
  })
  await app.goto(`${stack.url}/`)
  await list.computed
  await expect(railRow(app, "Race busy")).toHaveCount(0)
  await list.release()
  await expect(railRow(app, "Race painted")).toBeVisible()
  await expect(railRow(app, "Race busy").locator("[data-sidebar-status]")).toHaveAttribute("data-sidebar-status", "working")
  await expectRailEqualsServer(app, checked)
  expect(statusReads, "status, permission or question reads").toEqual([])
  await stack.acp.release("busy-before-open")
})

test("31 a list response after the session's own read keeps its stopped turn's outcome", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race stopped"], { open: false })
  const [stopped] = sessions
  await stack.acp.write("stopped-turn", { steps: [{ kind: "text", text: "Started before the stop" }, { kind: "hold", name: "stopped-turn" }] })
  await api.promptAsync(checked.directory, stopped.id, `Run ${acpScriptToken("stopped-turn")}`)
  const started = async () => assistantText(await api.messages(checked.directory, stopped.id))
  await expect.poll(started, { message: "the turn played its text before the hold" }).toContain("Started before the stop")
  await api.stopTurn(checked.directory, stopped.id)
  await expectServerStatus(checked, stopped.id, "Idle")
  const { workspaceId } = await api.resolveWorkspace(checked.directory)
  await app.goto("about:blank")
  const read = await holdListRead(app)
  await app.goto(`${stack.url}${sessionRoute(workspaceId, stopped.id)}`)
  await read.computed
  await expect(app.getByRole("main").getByText("Started before the stop")).toBeVisible()
  await read.release()
  await expectRailEqualsServer(app, checked)
  await expect(app.getByRole("main").getByText(/^You stopped after/)).toBeVisible()
})

test("31 a delete lands during a fetch", async ({ stack, api, app }) => {
  const titles = Array.from({ length: PAGE_SIZE + 5 }, (_, index) => `Race row ${index}`)
  const { checked } = await setup(stack, api, app, titles, { open: false })
  const order = await caseOrder(checked)
  const stream = await watchBrowserStream(app)
  const first = await reopenHoldingListRead(app, stack)
  await api.deleteSession(checked.directory, order[1])
  await patchSession(checked, order[2], { title: "Race fence first page" })
  await stream.received("Race fence first page")
  await first.release()
  await expectRailEqualsServer(app, checked)
  const more = await holdListRead(app, (url) => url.searchParams.has("after"))
  await app.getByTestId("rail-sidebar-session-load-more").first().click()
  await more.computed
  await api.deleteSession(checked.directory, order[3])
  await api.deleteSession(checked.directory, order[PAGE_SIZE + 2])
  await patchSession(checked, order[4], { title: "Race fence second page" })
  await stream.received("Race fence second page")
  await more.release()
  await expectRailEqualsServer(app, checked)
})

test("31 another browser creates a session", async ({ stack, api, app, browser }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race first", "Race second"])
  await expectRailEqualsServer(app, checked)
  const other = await (await browser.newContext()).newPage()
  await other.goto(`${stack.url}/`)
  await railRow(other, sessions[0].title).getByRole("button", { name: sessions[0].title, exact: true }).click()
  await other.getByRole("main").getByRole("button", { name: UI.newSession, exact: true }).click()
  await sendPrompt(other, "Start from the other browser")
  const listed = async () => (await api.sessions(checked.directory)).length
  await expect.poll(listed, { message: "the server lists the new session" }).toBe(3)
  await expectRailEqualsServer(app, checked)
  await expectRailEqualsServer(other, checked)
  await other.context().close()
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

test("31 settling and deleting running work are refused while rename remains available", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race settle me", "Race rename me", "Race delete me", "Race bystander"])
  const [settled, renamed, deleted] = sessions
  const holds = ["settle-turn", "rename-turn", "delete-turn"]
  for (const [index, hold] of holds.entries()) await startHeldTurn(checked, sessions[index].id, hold)
  for (const session of [settled, renamed, deleted]) await expectServerStatus(checked, session.id, "Working")
  await expectRailEqualsServer(app, checked)
  await expect(railRow(app, settled.title).getByRole("button", { name: `Settle ${settled.title}` })).toBeDisabled()
  const selected = await readerRow(stack, settled.id)
  const refused = await writeReader(stack, selected, { kind: "settle", revision: selected.reader?.revision ?? 0, activitySequence: selected.attention.activitySequence })
  expect(refused.status).toBe(409)
  expect(refused.body).toMatchObject({ ok: false, reason: "working" })
  await patchSession(checked, renamed.id, { title: "Race renamed mid-turn" })
  await expect(api.deleteSession(checked.directory, deleted.id), "the server refuses to delete running work").rejects.toMatchObject({ status: 409 })
  await expectRailEqualsServer(app, checked)
  for (const hold of holds) await stack.acp.release(hold)
  await expectServerStatus(checked, deleted.id, "Idle")
  await api.deleteSession(checked.directory, deleted.id)
  await expectServerStatus(checked, renamed.id, "Idle")
  await expectRailEqualsServer(app, checked)
})

test("31 an Activity read preserves live work and canonical order", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race moving activity", "Race activity bystander"])
  await sidebarFilter(app, "Activity")
  await expect(activityRow(app, sessions[0].title)).toBeVisible()
  const read = await holdListRead(app, (url) => url.searchParams.get("scope") === "all" && url.searchParams.get("settled") === "active")
  await api.createSession(checked.directory, { title: "Race Activity refresh", harness: SCRIPTED_ACP_HARNESS })
  await read.computed
  await startHeldTurn(checked, sessions[0].id, "activity-moved-during-read")
  await expectServerStatus(checked, sessions[0].id, "Working")
  await expect(app.getByRole("button", { name: sessions[0].title, exact: true })).toBeVisible()
  await read.release()
  await expectInventoryMatchesServer(app, stack, sessions.map((session) => session.id))
  await expect(activityRow(app, sessions[0].title)).toHaveCount(1)
  await stack.acp.release("activity-moved-during-read")
  await expectServerStatus(checked, sessions[0].id, "Idle")
  await expectInventoryMatchesServer(app, stack, sessions.map((session) => session.id))
})

test("31 a stale settle command cannot acknowledge a newer result", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race newer result", "Race reader bystander"])
  await stack.acp.write("reader-first", { steps: [{ kind: "text", text: "First off-screen result" }] })
  await api.prompt(checked.directory, sessions[0].id, `First ${acpScriptToken("reader-first")}`)
  const selected = await readerRow(stack, sessions[0].id)
  expect(selected.attention.outcome?.status).toBe("completed")
  await stack.acp.write("reader-second", { steps: [{ kind: "text", text: "Newer off-screen result" }] })
  await api.prompt(checked.directory, sessions[0].id, `Second ${acpScriptToken("reader-second")}`)
  await expect.poll(async () => (await readerRow(stack, sessions[0].id)).attention.outcome?.sequence).toBeGreaterThan(selected.attention.outcome!.sequence)
  const refused = await writeReader(stack, selected, { kind: "settle", revision: selected.reader?.revision ?? 0, activitySequence: selected.attention.activitySequence, outcomeSequence: selected.attention.outcome!.sequence })
  expect(refused.status).toBe(409)
  expect(refused.body).toMatchObject({ ok: false, reason: "activity_changed" })
  const current = await readerRow(stack, sessions[0].id)
  expect(current.reader?.seenThrough ?? 0).toBeLessThan(current.attention.outcome!.sequence)
  await sidebarFilter(app, "Activity")
  await expect(app.getByRole("button", { name: sessions[0].title, exact: true })).toBeVisible()
  await expectInventoryMatchesServer(app, stack, sessions.map((session) => session.id))
})

test("31 settling during an inventory read hides the active row, and new activity brings it back", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race settled during read", "Race settlement bystander"])
  const [settled] = sessions
  await stack.acp.write("settle-displayed-row", { steps: [{ kind: "text", text: "The result represented by the settled row." }] })
  await api.prompt(checked.directory, settled.id, `Settle later ${acpScriptToken("settle-displayed-row")}`)
  await expect.poll(async () => (await readerRow(stack, settled.id)).attention.outcome?.status).toBe("completed")
  const selected = await readerRow(stack, settled.id)
  await expect(railRow(app, settled.title)).toBeVisible()
  await sidebarFilter(app, "Activity")
  await expect(activityRow(app, sessions[0].title)).toBeVisible()
  const read = await holdListRead(app, (url) => url.searchParams.get("scope") === "all" && url.searchParams.get("settled") === "active")
  await api.createSession(checked.directory, { title: "Race Activity refresh", harness: SCRIPTED_ACP_HARNESS })
  await read.computed
  await sidebarFilter(app, "Projects")
  await railRow(app, settled.title).getByRole("button", { name: settled.title, exact: true }).focus()
  await railRow(app, settled.title).getByRole("button", { name: `Settle ${settled.title}` }).click()
  await expect(railRow(app, settled.title)).toHaveCount(0)
  const confirmed = await readerRow(stack, settled.id)
  expect(confirmed.reader).toMatchObject({ seenThrough: selected.attention.outcome!.sequence, settledThrough: selected.attention.activitySequence })
  expect((await api.session(checked.directory, settled.id)).time.archived).toBeUndefined()
  await read.release()
  await sidebarFilter(app, "Activity")
  await expectInventoryMatchesServer(app, stack, sessions.map((session) => session.id))
  await expect(app.getByRole("button", { name: settled.title, exact: true })).toHaveCount(0)
  await startHeldTurn(checked, settled.id, "settled-session-woke")
  await expectServerStatus(checked, settled.id, "Working")
  await expect(app.getByRole("button", { name: settled.title, exact: true })).toBeVisible()
  await expectInventoryMatchesServer(app, stack, sessions.map((session) => session.id))
  await stack.acp.release("settled-session-woke")
})

test("31 a thousand sessions, including the status of rows off screen", async ({ stack, api, app }) => {
  test.setTimeout(300_000)
  const titles = Array.from({ length: 1000 }, (_, index) => `Bulk ${String(index).padStart(4, "0")}`)
  const { sessions, checked } = await setup(stack, api, app, titles, { workspaces: 5, webSocket: true })
  const oldest = sessions[0]
  await startHeldTurn({ ...checked, directory: oldest.directory }, oldest.id, "off-screen")
  await expectServerStatus(checked, oldest.id, "Working")
  await expectRailEqualsServer(app, checked)
  await loadPagesUntil(app, checked, oldest.id)
  const rows = await expectRailEqualsServer(app, checked)
  expect(rows.find((row) => row.sessionId === oldest.id), "the oldest row, loaded last, shows the server's status").toEqual({ sessionId: oldest.id, title: oldest.title, status: "Working" })
  await stack.acp.release("off-screen")
})

test("31 the app reconnects after missed events", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race kept", "Race gone", "Race retitled", "Race prompted"])
  await expectRailEqualsServer(app, checked)
  const streams = await holdEventStreams(app)
  await stack.daemon.restart()
  await api.deleteSession(checked.directory, sessions[1].id)
  await patchSession(checked, sessions[2].id, { title: "Race retitled while away" })
  await stack.acp.write("away", { steps: [{ kind: "text", text: "Answered while away" }] })
  await api.prompt(checked.directory, sessions[3].id, `Hello ${acpScriptToken("away")}`)
  const created = await api.createSession(checked.directory, { title: "Race created while away", harness: SCRIPTED_ACP_HARNESS })
  checked.known.add(created.id)
  checked.directoryOf.set(created.id, checked.directory)
  streams.release()
  await expectRailEqualsServer(app, checked)
})
