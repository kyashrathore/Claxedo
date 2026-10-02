import { expect, installedCli, sessionRoute, test } from "../harness"
import { AGENT_LIKE_HUMAN_PROMPT, AGENT_OPENING_OBJECTIVE, playAgentAuthoredMessage } from "../harness/agent-authored-message"

test("46 stored agent-authored user rows render as events while human prompts remain bubbles", async ({ stack, api, app, isMobile }, testInfo) => {
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const { workspace, target } = await playAgentAuthoredMessage(stack, api)
  await app.goto(`${stack.url}${sessionRoute(workspace.id, target.sessionId)}`)
  const event = app.locator('[data-component="agent-message-notice"]')
  const body = event.locator(":scope > div")
  const human = app.locator('[data-component="user-message"]').filter({ hasText: AGENT_LIKE_HUMAN_PROMPT })
  await expect(event).toHaveCount(1)
  await expect(human).toHaveCount(1)
  await expect(event.locator("summary")).toHaveText("Message from Claude Code")
  await expect(body).toBeHidden()
  await event.locator("summary").click()
  await expect(body).toHaveText(`Goal: ${AGENT_OPENING_OBJECTIVE}`)
  await expect(event.getByRole("button", { name: "Copy message" })).toHaveCount(0)
  await event.locator("summary").click()
  await expect(body).toBeHidden()
  await app.reload()
  await expect(event).toHaveCount(1)
  await expect(human).toHaveCount(1)
  await event.locator("summary").click()
  for (const colorScheme of ["dark", "light"] as const) {
    await app.emulateMedia({ colorScheme })
    await expect(app.locator("html")).toHaveAttribute("data-color-scheme", colorScheme)
    expect(await event.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
    if (isMobile) expect((await event.locator("summary").boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await testInfo.attach(`agent-authored-event-${colorScheme}.png`, { body: await event.screenshot(), contentType: "image/png" })
  }
})
