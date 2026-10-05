import { expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI } from "../harness"

test("06 text typed in one draft stays in that draft: another workspace's draft and an open session start empty, and a reload keeps it", async ({ stack, api, app }) => {
  const first = await stack.daemon.makeWorkspace("draft-a")
  const second = await stack.daemon.makeWorkspace("draft-b")
  const session = await api.createSession(first.directory, { title: "Open session", harness: SCRIPTED_ACP_HARNESS })
  const prompt = app.getByRole("textbox", { name: UI.composer })
  await app.goto(`${stack.url}${sessionRoute(first.id)}`)
  await prompt.fill("Only in draft A")

  await app.goto(`${stack.url}${sessionRoute(second.id)}`)
  await expect(prompt).toHaveText("")
  await app.goto(`${stack.url}${sessionRoute(first.id, session.id)}`)
  await expect(app.getByRole("button", { name: UI.sendIdle })).toBeVisible()
  await expect(prompt).toHaveText("")
  await app.goto(`${stack.url}${sessionRoute(first.id)}`)
  await expect(prompt).toHaveText("Only in draft A")
  await app.reload()
  await expect(prompt).toHaveText("Only in draft A")
  const drafts = await app.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("claxedo:composer:") && key.includes(":draft:")))
  expect(drafts).toHaveLength(1)
  expect(drafts[0]).toMatch(/:(user:[^:]+|machine(:[^:]+)?):draft:draft_/)
})
