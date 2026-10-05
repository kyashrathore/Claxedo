import { expect, type ElectronApplication, type Page } from "@playwright/test"
import type { Desktop } from "./desktop"
import type { Account, SignedStack } from "./signed-stack"

export type SystemBrowser = { opened(): Promise<string[]> }

export async function interceptSystemBrowser(electron: ElectronApplication): Promise<SystemBrowser> {
  await electron.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.defineProperty(globalThis, "__claxedoSystemBrowser", { configurable: true, value: opened })
    Object.defineProperty(shell, "openExternal", { configurable: true, value: async (url: string) => void opened.push(url) })
  })
  return {
    opened: () => electron.evaluate(() => [...((globalThis as { __claxedoSystemBrowser?: string[] }).__claxedoSystemBrowser ?? [])]),
  }
}

function sessionCookie(url: string, account: Account) {
  const separator = account.person.cookie.indexOf("=")
  const name = account.person.cookie.slice(0, separator)
  const value = account.person.cookie.slice(separator + 1)
  return { name, value, url, secure: true, httpOnly: true, sameSite: "Lax" as const }
}

export async function signInDesktop(signed: SignedStack, desktop: Desktop, page: Page, account: Account = signed.owner): Promise<string> {
  const browser = await interceptSystemBrowser(desktop.electron)
  await desktop.window.getByRole("button", { name: "Sign in", exact: true }).click()
  await desktop.window.getByRole("menuitem", { name: "Sign in" }).click()
  await expect.poll(async () => (await browser.opened()).length).toBe(1)
  const [authorize] = await browser.opened()
  if (!authorize) throw new Error("main opened no authorization page")
  await page.context().addCookies([sessionCookie(signed.url, account)])
  await page.goto(authorize)
  await page.getByRole("button", { name: "Allow" }).click()
  await expect(desktop.window.getByRole("button", { name: account.name, exact: true })).toBeVisible()
  return authorize
}
