import { acpScriptToken, expect, expectNothingAnimating, SCRIPTED_ACP_HARNESS, sessionRoute, test } from "../harness"

const plain = Array.from({ length: 32 }, (_, index) => `Prompt instruction ${index + 1}: inspect this part of the project.`).join("\n")
const markdown = "# Project review\n\n" + Array.from({ length: 24 }, (_, index) => `- **Requirement ${index + 1}**: inspect this part of the project.`).join("\n")

for (const [shape, text] of [["plain", plain], ["markdown", markdown]]) {
  test(`30 long ${shape} user messages start folded, expand and collapse without losing the full prompt`, async ({ stack, api, app, isMobile }, testInfo) => {
    const workspace = await stack.daemon.makeWorkspace(`fold-${shape}`)
    await stack.acp.write(`fold-${shape}`, { steps: [{ kind: "text", text: "The full prompt was received." }] })
    const session = await api.createSession(workspace.directory, { title: `Fold ${shape}`, harness: SCRIPTED_ACP_HARNESS })
    const prompt = `${text}\n${acpScriptToken(`fold-${shape}`)}`
    await api.prompt(workspace.directory, session.id, prompt)
    await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
    await expect(app.getByText("The full prompt was received.", { exact: true })).toBeVisible()
    const bubble = app.locator('[data-component="user-message"]')
    const expand = bubble.getByRole("button", { name: "Show all", exact: true })
    await expect(expand).toBeVisible()
    await expect(expand).toHaveAttribute("aria-expanded", "false")
    const cardBounds = await expand.evaluate((element) => {
      const bounds = element.parentElement!.getBoundingClientRect()
      return { y: bounds.y, height: bounds.height }
    })
    const toggleBounds = (await expand.boundingBox())!
    expect(toggleBounds.y + toggleBounds.height).toBeLessThanOrEqual(cardBounds.y + cardBounds.height)
    expect(await expand.evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
    const foldedHeight = (await bubble.boundingBox())!.height
    expect(foldedHeight).toBeLessThan(340)
    if (isMobile) expect((await expand.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expand.click()
    const collapse = bubble.getByRole("button", { name: "Show less", exact: true })
    await expect(collapse).toHaveAttribute("aria-expanded", "true")
    expect((await bubble.boundingBox())!.height).toBeGreaterThan(foldedHeight + 200)
    await collapse.click()
    await expect(expand).toBeVisible()
    expect((await bubble.boundingBox())!.height).toBeLessThan(340)
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const messages = await api.messages(workspace.directory, session.id)
    expect(messages.find((message) => message.info.role === "user")?.parts.find((part) => part.type === "text")?.text).toBe(prompt)
    if (!isMobile) {
      await app.context().grantPermissions(["clipboard-read", "clipboard-write"])
      await bubble.hover()
      await bubble.getByRole("button", { name: "Copy message", exact: true }).click()
      expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(prompt)
    }
    for (const colorScheme of ["dark", "light"] as const) {
      await app.emulateMedia({ colorScheme })
      await expect(app.locator("html")).toHaveAttribute("data-color-scheme", colorScheme)
      const backgrounds = await expand.evaluate((element) => [getComputedStyle(element.parentElement!).backgroundColor, getComputedStyle(element.parentElement!.querySelector('[data-slot="user-message-text"]')!).backgroundColor])
      expect(backgrounds[0]).not.toBe("rgba(0, 0, 0, 0)")
      expect(backgrounds[1]).toBe("rgba(0, 0, 0, 0)")
      await expectNothingAnimating(app)
      await app.mouse.move(0, 0)
      await bubble.screenshot({ path: testInfo.outputPath(`${shape}-${colorScheme}.png`) })
    }
    await app.reload()
    await expect(expand).toHaveAttribute("aria-expanded", "false")
  })
}
