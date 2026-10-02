import { acpScriptToken, assistantText, expect, SCRIPTED_ACP_HARNESS, test, UI } from "../harness"
import { hostedFetch, inviteHostedPerson } from "../../../harness/e2e/harness/hosted-auth"

test("47 shared sessions: follow sees live turns, send reaches the owner, revoke makes the open session unavailable", async ({ signed, page, isMobile }) => {
  const recipient = await signed.signUp("Grace Recipient")
  const orgs = await hostedFetch(signed.hosted, "/api/control/orgs", {}, signed.owner.person)
  expect(orgs.status).toBe(200)
  const [{ org_id: orgId }] = await orgs.json() as Array<{ org_id: string }>
  const token = await inviteHostedPerson(signed.hosted, signed.owner.person, recipient.person, orgId!)
  const accepted = await hostedFetch(signed.hosted, "/api/control/invitations/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }, recipient.person)
  expect(accepted.status).toBe(200)
  const { user_id: grantedToUserId } = await accepted.json() as { user_id: string }
  const workspace = await signed.makeWorkspace("shared", "Owner's project")
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Shared design", harness: SCRIPTED_ACP_HARNESS })
  const share = async (method: "POST" | "DELETE", level?: "follow" | "send") => {
    const response = await hostedFetch(signed.hosted, `/api/control/sessions/${session.id}/shares`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, grantedToUserId, level }),
    }, signed.owner.person)
    expect(response.status).toBe(200)
  }
  await share("POST", "follow")
  await signed.signIn(page, recipient)
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  const section = page.getByTestId("shared-sessions")
  const row = section.getByTestId("shared-session-row")
  await expect(row).toContainText("Shared design")
  await expect(row).toContainText(`${signed.owner.name} · follow`)
  await row.click()
  const composer = page.getByTestId("follow-composer").getByRole("textbox", { name: "Follow session" })
  await expect(composer).toBeVisible()
  expect(await composer.evaluate((element) => (element as HTMLTextAreaElement).readOnly)).toBe(true)
  await expect(page.locator('[data-action="prompt-submit"]')).toHaveCount(0)
  await signed.local.acp.write("shared-live", { steps: [{ kind: "text", text: "Owner's live answer" }] })
  await signed.owner.api.prompt(workspace.directory, session.id, `Answer. ${acpScriptToken("shared-live")}`)
  await expect(page.getByText("Owner's live answer", { exact: true })).toBeVisible()

  await share("POST", "send")
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await section.getByRole("button", { name: "Refresh shared sessions" }).click()
  await expect(row).toContainText("· send")
  if (isMobile) await row.click()
  await expect(page.getByTestId("follow-composer")).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(0)
  await signed.local.acp.write("shared-send", { steps: [{ kind: "text", text: "Recipient's answer" }] })
  await page.getByRole("textbox", { name: UI.composer }).fill(`Recipient sends. ${acpScriptToken("shared-send")}`)
  await page.getByRole("button", { name: UI.send, exact: true }).click()
  await expect(page.getByText("Recipient's answer", { exact: true })).toBeVisible()
  await expect.poll(async () => assistantText(await signed.owner.api.messages(workspace.directory, session.id))).toContain("Recipient's answer")

  await share("DELETE")
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await section.getByRole("button", { name: "Refresh shared sessions" }).click()
  await expect(row).toHaveCount(0)
  if (isMobile) await page.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(page.getByTestId("session-unavailable")).toBeVisible()
})
