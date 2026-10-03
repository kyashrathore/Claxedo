import { acpScriptToken, apiRequests, expect, holdEveryRequest, SCRIPTED_ACP_HARNESS } from "../harness"
import { sidebarFilter } from "../harness/sidebar-filter"
import { holdListRead, setup, startHeldTurn, test } from "./31-session-list-races.controls"
import { activityRow, expectInventoryMatchesServer, readerRow, writeReader } from "./31-session-list-races.reader"

test.skip(({ isMobile }) => isMobile, "Flow 31 runs at desktop width; Flow 50 owns the phone canonical-fact path")

test("31 known canonical attention and reader notices update rows while metadata snapshots remain held", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race open bystander", "Race live canonical facts"])
  const target = sessions[1]
  await stack.acp.write("facts-first-result", { steps: [{ kind: "text", text: "First unseen result before the held metadata read" }] })
  await api.prompt(checked.directory, target.id, `First ${acpScriptToken("facts-first-result")}`)
  await sidebarFilter(app, "Activity")
  const activity = app.getByTestId("activity-sidebar")
  await expect(activity.getByRole("button", { name: target.title, exact: true })).toBeVisible()
  const quiet = apiRequests(app, stack.url)
  await quiet()
  const inventory = await holdEveryRequest(app, /\/api\/claxedo\/session-list\?.*\bscope=all\b/)
  const metadata = await holdListRead(app, (url) => url.searchParams.get("scope") === "project")
  await api.createSession(checked.directory, { title: "Race snapshot trigger", harness: SCRIPTED_ACP_HARNESS })
  await metadata.computed
  await startHeldTurn(checked, target.id, "facts-during-metadata")
  await expect(activityRow(app, target.title).locator('[data-sidebar-status="working"]')).toBeVisible()
  await stack.acp.release("facts-during-metadata")
  await expect(activity.getByRole("button", { name: target.title, exact: true })).toBeVisible()
  await expect.poll(async () => (await readerRow(stack, target.id)).attention.working).toBe(false)
  const current = await readerRow(stack, target.id)
  expect(current.attention.outcome?.status).toBe("completed")
  const seen = await writeReader(stack, current, { kind: "seen", outcomeSequence: current.attention.outcome!.sequence })
  expect(seen.status).toBe(200)
  await expect(activity.getByRole("button", { name: target.title, exact: true })).toBeVisible()
  const acknowledged = await readerRow(stack, target.id)
  expect(acknowledged.reader?.seenThrough).toBeGreaterThanOrEqual(current.attention.outcome!.sequence)
  const settled = await writeReader(stack, acknowledged, { kind: "settle", activitySequence: acknowledged.attention.activitySequence, outcomeSequence: acknowledged.attention.outcome!.sequence, revision: acknowledged.reader!.revision })
  expect(settled.status).toBe(200)
  expect(settled.body.ok).toBe(true)
  await expect(activity.getByRole("button", { name: target.title, exact: true })).toHaveCount(0)
  await metadata.release()
  inventory.release()
  await expectInventoryMatchesServer(app, stack, sessions.map((session) => session.id))
  await expect(activityRow(app, target.title)).toHaveCount(0)
  expect((await readerRow(stack, target.id)).reader?.seenThrough).toBeGreaterThanOrEqual(current.attention.outcome!.sequence)
  const returned = await writeReader(stack, await readerRow(stack, target.id), { kind: "return", revision: settled.body.state!.revision })
  expect(returned.status).toBe(200)
  await expect(activity.getByRole("button", { name: target.title, exact: true })).toBeVisible()
})
