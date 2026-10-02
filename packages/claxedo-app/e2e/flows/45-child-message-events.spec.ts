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
  expect(prompts).toHaveLength(1)
  expect(replies.length).toBeGreaterThan(1)
  expect(replies.every((message) => message.info.role === "assistant" && message.info.parentID === prompts[0]!.info.id)).toBe(true)
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
