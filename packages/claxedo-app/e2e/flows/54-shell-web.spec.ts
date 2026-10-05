import type { Page, Route } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, test, UI, type SignedStack } from "../harness"

async function held(page: Page, pattern: RegExp) {
  const waiting: Route[] = []
  let failing = false
  await page.route(pattern, async (route) => {
    if (failing) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "history read failed" }) })
    else waiting.push(route)
  })
  return {
    fail: () => (failing = true),
    seen: () => waiting.length,
    release: async () => {
      await Promise.all(waiting.splice(0).map((route) => route.continue()))
      await page.unroute(pattern)
    },
  }
}

async function showRail(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: UI.openRail }).click()
  return page.getByRole("navigation", { name: UI.rail })
}

async function sessionsIn(signed: SignedStack, titles: readonly string[]) {
  const workspace = await signed.makeWorkspace("shell", "Shell project")
  await signed.local.acp.write("hello", { steps: [{ kind: "text", text: "Hello from the agent" }] })
  const ids: string[] = []
  for (const title of titles) {
    const session = await signed.owner.api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
    await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("hello")}`)
    ids.push(session.id)
  }
  return { workspace, ids }
}

test("54 shell: sign-in shows the artwork beside the form on the web and the form alone on a phone", async ({ signed, page, isMobile }) => {
  await page.goto(`${signed.url}/login`)
  await expect(page.getByRole("heading", { name: "Sign in to Claxedo" })).toBeVisible()
  await expect(page.getByText("Every coding agent, on any machine, from anywhere.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible()
  await expect(page.getByTestId("sign-in-artwork")).toBeVisible({ visible: !isMobile })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await signed.signIn(page, signed.owner)
  const session = await page.request.get(`${signed.url}/api/auth/get-session`)
  expect(((await session.json()) as { user: { email: string } }).user.email).toBe(signed.owner.email)
})

test("54 shell: rows are two lines, the home screen offers only the composer, the account menu repeats neither the name nor Settings, and logout stays in the menu until it is done", async ({ signed, page, isMobile }, testInfo) => {
  await sessionsIn(signed, ["Fix the login redirect"])
  await signed.signIn(page, signed.owner)
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await expect(picker).toBeVisible()
  await expect(picker).toBeInViewport({ ratio: 1 })
  await page.keyboard.press("Escape")
  const rail = await showRail(page, isMobile)
  const row = rail.getByTestId("rail-sidebar-session-row").filter({ has: page.getByRole("button", { name: "Fix the login redirect", exact: true }) })
  await expect(row.getByRole("img", { name: "shell on Signed fixture machine" })).toBeVisible()
  await expect(row.getByText("Signed fixture machine", { exact: true })).toBeVisible()
  await expect(row.getByText("<1m", { exact: true })).toBeVisible()
  const title = await row.getByText("Fix the login redirect", { exact: true }).boundingBox()
  const meta = await row.getByText("<1m", { exact: true }).boundingBox()
  expect(title && meta && meta.y >= title.y + title.height - 1, "the meta line sits under the title line").toBe(true)
  await page.screenshot({ path: testInfo.outputPath("rail-two-line-rows.png") })

  const signOut = await held(page, /\/api\/auth\/sign-out/)
  await page.getByRole("button", { name: signed.owner.name, exact: true }).click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem", { name: "Usage" })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: "Settings" })).toBeVisible()
  await expect(menu.getByText(signed.owner.name, { exact: true })).toHaveCount(0)
  await page.getByRole("menuitem", { name: "Log out" }).click()
  await expect(page.getByRole("menuitem", { name: "Signing out…" })).toBeDisabled()
  await expect.poll(signOut.seen).toBe(1)
  await expect(page.getByRole("menuitem", { name: "Signing out…" })).toBeVisible()
  await signOut.release()
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get(`${signed.url}/api/workspace?host=provisioner`)).status()).toBe(401)
})

test("54 shell: a slow session shows the composer and says what it waits for; a failed read offers Retry; the rail list stays", async ({ signed, page, isMobile }) => {
  const { workspace, ids } = await sessionsIn(signed, ["Slow history", "Other session"])
  await signed.signIn(page, signed.owner)
  const rail = await showRail(page, isMobile)
  await expect(rail.getByRole("button", { name: "Slow history", exact: true })).toBeVisible()
  await page.evaluate(() => {
    const seen = { loading: false }
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="rail-sidebar-session-list-loading"]')) seen.loading = true
    }).observe(document.body, { childList: true, subtree: true })
    Object.assign(window, { railLoadingSeen: seen })
  })

  const history = await held(page, new RegExp(ids[0]))
  await rail.getByRole("button", { name: "Slow history", exact: true }).click()
  await expect(page.getByTestId("session-messages-loading")).toBeVisible()
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(page.getByText("Still reading this session's history from Signed fixture machine.")).toBeVisible()
  await history.release()
  await expect(page.getByText("Hello from the agent")).toBeVisible()

  if (isMobile) await showRail(page, isMobile)
  const retry = await held(page, new RegExp(ids[1]))
  retry.fail()
  await rail.getByRole("button", { name: "Other session", exact: true }).click()
  await expect(page.getByText("Could not load this session.")).toBeVisible()
  await retry.release()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByText("Hello from the agent")).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { railLoadingSeen: { loading: boolean } }).railLoadingSeen.loading)).toBe(false)
  expect(JSON.stringify(await signed.owner.api.messages(workspace.directory, ids[1]))).toContain("Hello from the agent")
})
