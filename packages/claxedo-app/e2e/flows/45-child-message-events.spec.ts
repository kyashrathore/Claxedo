import { expect, installedCli, sendPrompt, sessionRoute, test } from "../harness"
import { isRecord } from "@claxedo/helpers/guards"
import { prepareChildMessageEvent } from "../harness/child-message-event"

test("45 native Claude child handback renders as an expandable event", async ({ stack, api, app, isMobile }, testInfo) => {
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const { workspace, session, prompt } = await prepareChildMessageEvent(stack, api)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await sendPrompt(app, prompt)
  const event = app.locator('[data-component="agent-message-notice"]').filter({ hasText: "CHILDREPORT" })
  try {
    await expect(event).toHaveCount(1, { timeout: 30_000 })
  } catch (error) {
    await testInfo.attach("model-requests.json", { body: JSON.stringify(stack.scripted.requests), contentType: "application/json" })
    await testInfo.attach("parent-messages.json", { body: JSON.stringify(await api.messages(workspace.directory, session.id)), contentType: "application/json" })
    throw error
  }
  await expect(event.locator("summary")).toContainText("Message from")
  await expect(event.locator("div")).toBeHidden()
  await event.locator("summary").click()
  await expect(event.locator("div")).toHaveText("CHILDREPORT")
  await event.locator("summary").click()
  await expect(event.locator("div")).toBeHidden()
  await app.reload()
  await expect(event).toHaveCount(1)
  const messages = await api.messages(workspace.directory, session.id)
  const prompts = messages.filter((message) => message.info.role === "user")
  const replies = messages.filter((message) => message.info.role === "assistant")
  const openedBy = (message: (typeof messages)[number]) =>
    isRecord(message.info.claxedo) && isRecord(message.info.claxedo.author) ? message.info.claxedo.author.id : undefined
  const human = prompts.filter((message) => openedBy(message) === undefined)
  const own = prompts.filter((message) => openedBy(message) === "harness:claude")
  expect(human).toHaveLength(1)
  expect(own.length, "each turn Claude Code began on its own opens with its own message").toBeGreaterThan(0)
  expect(own.length + human.length).toBe(prompts.length)
  for (const opening of own) expect(opening.parts).toMatchObject([{ type: "text", text: "Continued on its own" }])
  expect(replies.filter((message) => message.info.parentID === human[0].info.id)).toHaveLength(1)
  for (const opening of own) expect(replies.filter((message) => message.info.parentID === opening.info.id)).toHaveLength(1)
  expect(replies).toHaveLength(prompts.length)
  expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "notice" && isRecord(part.notice) && part.notice.kind === "agent-message"))
    .toHaveLength(1)
  await event.locator("summary").click()
  for (const colorScheme of ["dark", "light"] as const) {
    await app.emulateMedia({ colorScheme })
    await expect(app.locator("html")).toHaveAttribute("data-color-scheme", colorScheme)
    expect(await event.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
    await expect(event.locator("div")).toHaveText("CHILDREPORT")
    if (isMobile) expect((await event.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await testInfo.attach(`child-message-event-${colorScheme}.png`, { body: await event.screenshot(), contentType: "image/png" })
  }
})
