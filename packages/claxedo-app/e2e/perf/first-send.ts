import { chromium, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { prepareHarness } from "../harness/global-setup"
import { startStack } from "../harness/stack"
import { sessionRoute, UI } from "../harness/ui-names"

const REPS = Number(process.env.FIRST_SEND_REPS ?? 10)

type Marks = { down?: number; message?: number; token?: number }

declare global {
  interface Window {
    __firstSend: Marks
    __firstSendWatch: (text: string) => void
  }
}

async function firstSend(page: Page, url: string, workspaceId: string, rep: number) {
  await page.goto(`${url}${sessionRoute(workspaceId)}`)
  const text = `First send ${rep}.`
  await page.getByRole("textbox", { name: UI.composer }).click()
  await page.keyboard.type(text)
  const submit = page.locator('[data-action="prompt-submit"]').filter({ visible: true })
  await submit.waitFor()
  await page.getByRole("button", { name: UI.send, exact: true }).and(page.locator(":enabled")).waitFor()
  await page.evaluate((needle) => window.__firstSendWatch(needle), text)
  await submit.click()
  await page.waitForFunction(() => window.__firstSend.message !== undefined && window.__firstSend.token !== undefined, undefined, { timeout: 30_000 }).catch(async (error: unknown) => {
    const seen = await page.evaluate(() => ({
      url: location.href,
      marks: window.__firstSend,
      users: [...document.querySelectorAll('[data-component="user-message"]')].map((node) => node.textContent),
      texts: [...document.querySelectorAll('[data-component="text-part"]')].map((node) => node.textContent),
    }))
    throw new Error(`rep ${rep} never painted both marks: ${JSON.stringify(seen)}`, { cause: error })
  })
  return await page.evaluate(() => window.__firstSend)
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

async function main() {
  const label = process.argv[2] ?? "run"
  const out = path.join(process.env.FIRST_SEND_OUT ?? path.join(import.meta.dirname, "results"), `first-send-${label}.json`)
  await prepareHarness()
  const stack = await startStack({ label: "first-send" })
  const browser = await chromium.launch({ channel: "chromium" })
  try {
    const workspace = await stack.daemon.makeWorkspace("first-send", "First send")
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "en-US", timezoneId: "UTC" })
    await context.addInitScript({ path: path.join(import.meta.dirname, "first-send-probe.js") })
    const page = await context.newPage()
    const runs: Marks[] = []
    for (let rep = 0; rep < REPS; rep += 1) {
      const marks = await firstSend(page, stack.url, workspace.id, rep)
      console.log(JSON.stringify({ rep, message: marks.message, token: marks.token }))
      runs.push(marks)
    }
    const measured = runs.slice(1)
    const summary = {
      label,
      reps: measured.length,
      messageMedianMs: median(measured.map((run) => run.message!)),
      tokenMedianMs: median(measured.map((run) => run.token!)),
      runs,
    }
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, JSON.stringify(summary, null, 1))
    console.log(JSON.stringify({ label, reps: summary.reps, messageMedianMs: summary.messageMedianMs, tokenMedianMs: summary.tokenMedianMs }))
  } finally {
    await browser.close()
    await stack.close()
  }
}

await main()
