import type { Browser, BrowserContext } from "@playwright/test"
import fs from "node:fs"
import { isRecord } from "@claxedo/helpers/guards"
import { readBoolean, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import type { DistBytes } from "./bytes"
import type { Profile } from "./profiles"

export type Cookie = Parameters<BrowserContext["addCookies"]>[0][number]

export type SessionTarget = { readonly id: string; readonly url: string }

export type Target = {
  readonly kind: "local" | "url"
  readonly url: string
  readonly cookies: readonly Cookie[]
  readonly sessions: readonly SessionTarget[]
  readonly distDir: string | undefined
  readonly bytes: DistBytes | undefined
  readonly description: string
  useProfile(profile: Profile): void
  close(): Promise<void>
}

function sameSite(value: string | undefined): Cookie["sameSite"] {
  const lower = value?.toLowerCase()
  if (lower === "strict") return "Strict"
  if (lower === "none" || lower === "no_restriction") return "None"
  return "Lax"
}

export function readCookieFile(file: string, origin: string): Cookie[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : undefined
  if (!list) throw new Error(`${file} holds neither a cookie array nor a storageState with cookies`)
  const host = new URL(origin).hostname
  return list.flatMap((entry): Cookie[] => {
    const name = readString(entry, "name")
    const value = readString(entry, "value")
    if (name === undefined || value === undefined) return []
    const domain = readString(entry, "domain") ?? host
    const expires = readFiniteNumber(entry, "expires") ?? readFiniteNumber(entry, "expirationDate") ?? -1
    return [{ name, value, domain, path: readString(entry, "path") ?? "/", expires, httpOnly: readBoolean(entry, "httpOnly") ?? false, secure: readBoolean(entry, "secure") ?? true, sameSite: sameSite(readString(entry, "sameSite")) }]
  })
}

export function describeCookies(cookies: readonly Cookie[]) {
  return cookies.map((cookie) => cookie.name).join(", ")
}

export async function discoverSessions(browser: Browser, target: Pick<Target, "url" | "cookies">): Promise<SessionTarget[]> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    await context.addCookies(target.cookies)
    const page = await context.newPage()
    await page.goto(target.url)
    const rows = page.locator('[data-slot="session-navigation-row"]')
    await rows.first().waitFor({ timeout: 60_000 })
    const ids = (await rows.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.sessionId ?? ""))).filter(Boolean).slice(0, 2)
    if (ids.length < 2) throw new Error(`${target.url} lists ${ids.length} session(s); the scenarios need two`)
    const sessions: SessionTarget[] = []
    for (const id of ids) {
      await page.locator(`[data-slot="session-navigation-row"][data-session-id="${id}"] [data-slot="navigation-row-activate"]`).click()
      await page.waitForURL((url) => url.pathname.includes(id), { timeout: 30_000 })
      sessions.push({ id, url: page.url() })
    }
    return sessions
  } finally {
    await context.close()
  }
}

export async function urlTarget(input: { url: string; cookieFile: string }): Promise<Omit<Target, "sessions">> {
  const url = new URL(input.url).origin
  const cookies = readCookieFile(input.cookieFile, url)
  if (cookies.length === 0) throw new Error(`${input.cookieFile} holds no cookies`)
  return {
    kind: "url",
    url,
    cookies,
    distDir: undefined,
    bytes: undefined,
    description: `${url} with cookies ${describeCookies(cookies)} from ${input.cookieFile}`,
    useProfile: () => undefined,
    close: async () => undefined,
  }
}
