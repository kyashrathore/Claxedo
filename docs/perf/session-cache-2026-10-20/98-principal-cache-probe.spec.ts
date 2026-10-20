import fs from "node:fs"
import type { Page, Response } from "@playwright/test"
import { expect, test, UI } from "../harness"

const OUT = process.env.PRINCIPAL_CACHE_PROBE_OUT

type Answer = { readonly path: string; readonly status: number; readonly auth: number; readonly setsCache: boolean }

function recordSigned(page: Page, origin: string) {
  const answers: Promise<Answer>[] = []
  page.on("response", (response: Response) => {
    const url = new URL(response.url())
    if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth/") || url.pathname.endsWith("/events")) return
    answers.push((async () => {
      const headers = await response.headersArray()
      const timing = headers.find((header) => header.name.toLowerCase() === "server-timing")?.value ?? ""
      return {
        path: url.pathname.replace(/ws_[\w-]+|[0-9a-f-]{36}/g, "…"),
        status: response.status(),
        auth: Number(/(?:^|, )auth;dur=([0-9.]+)/.exec(timing)?.[1] ?? Number.NaN),
        setsCache: headers.some((header) => header.name.toLowerCase() === "set-cookie" && header.value.startsWith("__Host-claxedo.principal=")),
      }
    })())
  })
  return async () => await Promise.all(answers)
}

test("98 principal cache probe: a signed boot verifies live and sets the cache; a reload inside 60 s is admitted on it", async ({ signed, page }, testInfo) => {
  test.setTimeout(180_000)
  await signed.makeWorkspace("principal-cache", "Principal cache")
  const first = recordSigned(page, signed.url)
  await signed.signIn(page, signed.owner)
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1_500)
  const boot = await first()
  const cookies = await page.context().cookies(signed.url)
  const cache = cookies.find((cookie) => cookie.name === "__Host-claxedo.principal")

  page.removeAllListeners("response")
  const second = recordSigned(page, signed.url)
  await page.reload()
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1_500)
  const reload = await second()

  const text = [
    `cache cookie: ${cache ? `httpOnly=${cache.httpOnly} secure=${cache.secure} sameSite=${cache.sameSite} expires in ${Math.round(cache.expires - Date.now() / 1_000)} s` : "absent"}`,
    "boot:",
    ...boot.map((answer) => `  ${answer.status} auth=${answer.auth} ${answer.setsCache ? "sets cache " : ""}${answer.path}`),
    "reload:",
    ...reload.map((answer) => `  ${answer.status} auth=${answer.auth} ${answer.setsCache ? "sets cache " : ""}${answer.path}`),
  ].join("\n")
  console.log(text)
  await testInfo.attach("principal-cache", { body: text, contentType: "text/plain" })
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ cache, boot, reload }, null, 2))

  expect(cache?.httpOnly).toBe(true)
  expect(boot.some((answer) => answer.setsCache)).toBe(true)
  expect(reload.length).toBeGreaterThan(0)
  expect(reload.filter((answer) => answer.setsCache || answer.auth > 0.5)).toEqual([])
})
