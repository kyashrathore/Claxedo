import {
  acpScriptToken,
  assistantText,
  createCloudSession,
  expect,
  makeCloudWorkspace,
  SCRIPTED_ACP_HARNESS,
  signInDesktop,
  startCloudWorkspace,
  test,
  UI,
  type SignedStack,
} from "../harness"
import { hostedFetch, inviteHostedPerson } from "../../../harness/e2e/harness/hosted-auth"

async function ownersColleague(signed: SignedStack, name: string) {
  const colleague = await signed.signUp(name)
  const orgs = await hostedFetch(signed.hosted, "/api/control/orgs", {}, signed.owner.person)
  expect(orgs.status).toBe(200)
  const [{ org_id: orgId }] = await orgs.json() as Array<{ org_id: string }>
  const token = await inviteHostedPerson(signed.hosted, signed.owner.person, colleague.person, orgId!)
  const accepted = await hostedFetch(signed.hosted, "/api/control/invitations/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }, colleague.person)
  expect(accepted.status).toBe(200)
  const { user_id: userId } = await accepted.json() as { user_id: string }
  return { ...colleague, userId }
}

function sharing(signed: SignedStack, input: { workspaceId: string; sessionId: string; userId: string }) {
  return async (method: "POST" | "DELETE", level?: "follow" | "send") => {
    const response = await hostedFetch(signed.hosted, `/api/control/sessions/${input.sessionId}/shares`, {
      method, headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: input.workspaceId, grantedToUserId: input.userId, level }),
    }, signed.owner.person)
    expect(response.status, await response.text()).toBe(200)
  }
}

test("47 shared sessions: follow sees live turns, send reaches the owner, revoke makes the open session unavailable", async ({ signed, page, isMobile }) => {
  const recipient = await ownersColleague(signed, "Grace Recipient")
  const workspace = await signed.makeWorkspace("shared", "Owner's project")
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Shared design", harness: SCRIPTED_ACP_HARNESS })
  const share = sharing(signed, { workspaceId: workspace.id, sessionId: session.id, userId: recipient.userId })
  await share("POST", "follow")
  await signed.signIn(page, recipient)
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  const section = page.getByTestId("shared-sessions")
  const row = section.getByTestId("shared-session-row")
  await expect(row).toContainText("Shared design")
  await expect(row).toContainText(`${signed.owner.name} · can follow`)
  await row.click()
  const editor = page.locator('[data-component="prompt-input"]')
  await expect(editor).toHaveAttribute("contenteditable", "false")
  await expect(editor).toHaveAttribute("aria-label", "You can follow this session, not send to it")
  await expect(page.locator('[data-action="prompt-submit"]')).toBeDisabled()
  await signed.local.acp.write("shared-live", { steps: [{ kind: "text", text: "Owner's live answer" }] })
  await signed.owner.api.prompt(workspace.directory, session.id, `Answer. ${acpScriptToken("shared-live")}`)
  await expect(page.getByText("Owner's live answer", { exact: true })).toBeVisible()

  await share("POST", "send")
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await section.getByRole("button", { name: "Refresh shared sessions" }).click()
  await expect(row).toContainText("· can send")
  if (isMobile) await row.click()
  await expect(editor).toHaveAttribute("contenteditable", "true")
  await expect(page.locator('[data-action="prompt-harness-model"]')).toHaveCount(0)
  await signed.local.acp.write("shared-send", { steps: [{ kind: "text", text: "Recipient's answer" }] })
  await page.getByRole("textbox", { name: UI.composer }).fill(`Recipient sends. ${acpScriptToken("shared-send")}`)
  await page.getByRole("button", { name: UI.send, exact: true }).click()
  await expect(page.getByText("Recipient's answer", { exact: true })).toBeVisible()
  await expect.poll(async () => assistantText(await signed.owner.api.messages(workspace.directory, session.id))).toContain("Recipient's answer")

  // The revoke's doorbell reaches the recipient's live room, so the row goes
  // without a refresh.
  await share("DELETE")
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await expect(row).toHaveCount(0)
  if (isMobile) await page.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(page.getByTestId("session-unavailable")).toBeVisible()
})

test("47 a send share's turn spends the session owner's account, never the sender's", async ({ signedCloud: signed, page, isMobile }) => {
  test.setTimeout(150_000)
  const recipient = await ownersColleague(signed, "Grace Recipient")
  for (const [person, key] of [[signed.owner.person, "ss47-owner-key"], [recipient.person, "ss47-recipient-key"]] as const) {
    const stored = await hostedFetch(signed.hosted, "/auth/openai?harness=pi", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ auth: { key } }),
    }, person)
    expect(stored.status, await stored.text()).toBe(200)
  }
  const workspace = await makeCloudWorkspace(signed, "shared-cloud")
  await startCloudWorkspace(signed, workspace)
  const sessionId = await createCloudSession(signed, workspace, {
    title: "Shared cloud", harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" },
  })
  await sharing(signed, { workspaceId: workspace.id, sessionId, userId: recipient.userId })("POST", "send")
  await signed.signIn(page, recipient)
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  await page.getByTestId("shared-session-row").filter({ hasText: "Shared cloud" }).click()
  await page.getByRole("textbox", { name: UI.composer }).fill("Reply with exactly this one token: SS47SEND")
  await page.getByRole("button", { name: UI.send, exact: true }).click()
  await expect.poll(() => signed.hosted.model.requests.find((request) => request.prompt.includes("SS47SEND"))?.authorization, { timeout: 60_000 })
    .toBe("Bearer ss47-owner-key")
})

test("47 signed desktop: a session shared with the account lists and opens through main's account, and its send reaches the owner", { tag: "@desktop" }, async ({ signedCloud: signed, signedDesktop, page }) => {
  const recipient = await ownersColleague(signed, "Grace Recipient")
  const workspace = await signed.makeWorkspace("shared-desktop", "Owner's project")
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Shared on desktop", harness: SCRIPTED_ACP_HARNESS })
  await sharing(signed, { workspaceId: workspace.id, sessionId: session.id, userId: recipient.userId })("POST", "send")
  await signedDesktop.makeWorkspace("local", "Local")
  await signedDesktop.window.reload()
  await signInDesktop(signed, signedDesktop, page, recipient)
  const window = signedDesktop.window
  const row = window.getByTestId("shared-session-row").filter({ hasText: "Shared on desktop" })
  await expect(row).toContainText(`${signed.owner.name} · can send`)
  await row.click()
  const screen = window.locator(`[data-testid="session-page-root"][data-session-id="${session.id}"]`)
  await signed.local.acp.write("shared-desktop", { steps: [{ kind: "text", text: "Desktop recipient's answer" }] })
  await screen.getByRole("textbox", { name: UI.composer }).fill(`Desktop sends. ${acpScriptToken("shared-desktop")}`)
  await screen.getByRole("button", { name: UI.send, exact: true }).click()
  await expect(window.getByText("Desktop recipient's answer", { exact: true })).toBeVisible()
  await expect.poll(async () => assistantText(await signed.owner.api.messages(workspace.directory, session.id))).toContain("Desktop recipient's answer")
})
