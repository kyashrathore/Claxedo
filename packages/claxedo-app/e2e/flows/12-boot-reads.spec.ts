import type { Page } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionCookie, sessionRoute, test } from "../harness"
import { shellPreloadPaths } from "../../../claxedo-server/scripts/deploy/shell-preloads"

type Read = { readonly path: string; readonly startMs: number; readonly endMs: number; readonly initiator: string }

async function bootReads(page: Page): Promise<{ main: Read; api: Read[] }> {
  const reads = await page.evaluate(() =>
    performance.getEntriesByType("resource").filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming).map((entry) => {
      const url = new URL(entry.name)
      return { path: `${url.pathname}${url.search}`, startMs: entry.startTime, endMs: entry.responseEnd, initiator: entry.initiatorType }
    }),
  )
  const main = reads.find((read) => /^\/assets\/main-[^/]+\.js$/.test(read.path))
  if (!main) throw new Error("the boot loaded no main chunk")
  return { main, api: reads.filter((read) => read.path.startsWith("/api/")) }
}

test("12 boot reads: a signed-out boot reads only the session; a signed-in boot's reads leave with the shell and are read once", async ({ signed, page }) => {
  const workspace = await signed.makeWorkspace("boot-reads", "Boot reads")
  await signed.local.acp.write("hello", { steps: [{ kind: "text", text: "Preloaded hello" }] })
  const session = await signed.owner.api.createSession(workspace.directory, { title: "Boot reads", harness: SCRIPTED_ACP_HARNESS })
  await signed.owner.api.prompt(workspace.directory, session.id, `Say hello. ${acpScriptToken("hello")}`)
  const route = sessionRoute(workspace.id, session.id)

  const signedOutMark = signed.controlPlaneRequests().length
  await page.goto(`${signed.url}${route}`)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible()
  const signedOut = await bootReads(page)
  expect(signedOut.api.map((read) => read.path)).toEqual(["/api/auth/get-session"])
  expect(signed.controlPlaneRequests().slice(signedOutMark).filter((request) => request.startsWith("GET /api/workspace"))).toEqual([])

  await page.context().addCookies([sessionCookie(signed.url, signed.owner)])
  const signedInMark = signed.controlPlaneRequests().length
  await page.goto(`${signed.url}${route}`)
  await expect(page.getByText("Preloaded hello")).toBeVisible()
  const signedIn = await bootReads(page)
  const preloaded = shellPreloadPaths(route)
  for (const path of preloaded) {
    const reads = signedIn.api.filter((read) => read.path === path)
    expect(reads, path).toHaveLength(1)
    expect(reads[0]?.initiator, path).toBe("link")
    expect(reads[0]?.startMs, path).toBeLessThan(signedIn.main.endMs)
  }
  expect(signedIn.api.filter((read) => read.initiator === "link").map((read) => read.path).sort()).toEqual([...preloaded].sort())
  const forwarded = signed.controlPlaneRequests().slice(signedInMark)
  expect(forwarded.filter((request) => request === "GET /api/auth/get-session")).toHaveLength(1)
  expect(forwarded.filter((request) => request === `GET /api/workspace/${workspace.id}/connection`)).toHaveLength(1)
})
