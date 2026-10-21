import { acpScriptToken, assistantText, expect, ownersColleague, SCRIPTED_ACP_HARNESS, sessionCookie, sharing, test, UI } from "../harness"

test("57 lost turn lease: a sender's turn whose renewal is refused stops the spinner, shows the interruption and resumes", async ({ signed, page, browser, isMobile }) => {
  test.setTimeout(150_000)
  const recipient = await ownersColleague(signed, "Grace Sender")
  const workspace = await signed.makeWorkspace("lost-lease", "Owner's project")
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Lease lost", harness: SCRIPTED_ACP_HARNESS })
  const share = sharing(signed, { workspaceId: workspace.id, sessionId: session.id, userId: recipient.userId })
  await share("POST", "send")
  await signed.local.acp.write("lease-held", { steps: [
    { kind: "text", text: "Saved before the lease ended" },
    { kind: "hold", name: "lease-held" },
    { kind: "text", text: "Written after the lease ended" },
  ] })

  await signed.signIn(page, signed.owner)
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await page.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Lease lost", exact: true }).click()
  const senderContext = await browser.newContext({ ignoreHTTPSErrors: true })
  await senderContext.addCookies([sessionCookie(signed.url, recipient)])
  const sender = await senderContext.newPage()
  await sender.goto(signed.url)
  if (isMobile) await sender.getByRole("button", { name: UI.openRail }).click()
  await sender.getByTestId("shared-session-row").filter({ hasText: "Lease lost" }).click()
  await sender.getByRole("textbox", { name: UI.composer }).fill(`Work on it. ${acpScriptToken("lease-held")}`)
  await sender.getByRole("button", { name: UI.send, exact: true }).click()
  await expect(page.getByText("Saved before the lease ended")).toBeVisible()
  await expect(page.getByRole("button", { name: UI.stop, exact: true })).toBeVisible()

  await share("POST", "follow")

  const notice = page.getByRole("region", { name: "Session interrupted", exact: true })
  await expect(notice).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("button", { name: UI.stop, exact: true })).toHaveCount(0)
  await expect(page.locator('[data-sidebar-status="working"]')).toHaveCount(0)
  await expect(page.getByText("Saved before the lease ended")).toBeVisible()
  expect((await signed.owner.api.status(workspace.directory))[session.id]?.type).toBe("interrupted")
  expect((await signed.owner.api.session(workspace.directory, session.id)).lastTurn).toBeUndefined()

  await notice.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect.poll(async () => (await signed.owner.api.session(workspace.directory, session.id)).lastTurn, { timeout: 30_000 })
    .toMatchObject({ status: "completed" })
  const messages = await signed.owner.api.messages(workspace.directory, session.id)
  expect(messages.filter((message) => message.info.role === "user")).toHaveLength(2)
  expect(assistantText(messages)).toContain("Saved before the lease ended")
  expect(assistantText(messages)).not.toContain("Written after the lease ended")
  await senderContext.close()
})
