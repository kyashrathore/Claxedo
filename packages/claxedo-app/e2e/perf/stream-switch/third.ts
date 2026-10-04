import type { Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { SCRIPTED_ACP_HARNESS } from "../../../../harness/e2e/harness/acp/connection"
import { acpScriptToken } from "../../../../harness/e2e/harness/acp/script"
import { sendPrompt } from "../../harness/composer"
import { sessionRoute, UI } from "../../harness/ui-names"
import { streamScript } from "../stream-script"
import { recordScreen } from "./screen"
import { desktopSurface, dwell, seedSession, webSurface } from "./surface"

const SEED_TURNS = Number(process.env.SEED_TURNS ?? "4")
const WATCH_MS = Number(process.env.WATCH_MS ?? "12000")
const OUT = process.env.OUT ?? path.join(process.env.HOME ?? "", "test/claxedo-perf-private/perf/stream-switch/third")
const TARGET = process.env.TARGET ?? "web"
const EXTRA = Number(process.env.EXTRA ?? "0")
const VIDEO = process.env.VIDEO === "1"
const THROTTLE = Number(process.env.THROTTLE ?? "1")
const C_HOLD_MS = Number(process.env.C_HOLD_MS ?? "0")

function snapshot(page: Page) {
  return page.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-workbench-content]")].map((slot) => {
      const style = getComputedStyle(slot)
      const box = slot.getBoundingClientRect()
      const root = slot.querySelector<HTMLElement>('[data-testid="session-page-root"]')
      return {
        key: slot.dataset.workbenchContent ?? "",
        presence: slot.dataset.presence ?? "",
        stashed: slot.dataset.stashed ?? "",
        cv: style.contentVisibility,
        vis: style.visibility,
        opacity: style.opacity,
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        session: root?.dataset.sessionId ?? null,
        rows: slot.querySelectorAll("[data-timeline-key]").length,
        text: (slot.textContent ?? "").replace(/\s+/g, " ").slice(0, 160),
        children: slot.childElementCount,
      }
    })
    const active = document.querySelector<HTMLElement>('[data-testid="rail-sidebar-session-row"][data-active="true"]')
    return { at: performance.now(), url: location.pathname, rail: active?.dataset.sessionId ?? "", slots }
  })
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const surface = TARGET === "desktop" ? await desktopSurface() : await webSurface(1)
  const errors: string[] = []
  try {
    const { api, workspace } = surface
    const alpha = await seedSession(surface, "Alpha", SEED_TURNS)
    const bravo = await seedSession(surface, "Bravo", SEED_TURNS)
    const extras: string[] = []
    for (let index = 1; index <= EXTRA; index += 1) extras.push((await api.createSession(workspace.directory, { title: `Extra ${index}`, harness: SCRIPTED_ACP_HARNESS })).id)
    for (const name of ["stream-a", "stream-b"]) await surface.writeScript(name, streamScript(workspace.directory))
    const cScript = streamScript(workspace.directory)
    await surface.writeScript("stream-c", C_HOLD_MS > 0 ? { ...cScript, steps: [{ kind: "hold", name: "c-boot" }, ...cScript.steps] } : cScript)
    const { page, cdp, bounds } = await surface.open()
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`)
    })
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack ?? error.message}`))
    if (TARGET === "desktop") {
      await page.reload()
      await page.locator('[data-testid="rail-sidebar-session-row"]').first().waitFor({ state: "visible", timeout: 60_000 })
    } else {
      await page.goto(`${surface.url}${sessionRoute(workspace.id, alpha)}`)
      await page.getByText(`Seed turn ${SEED_TURNS} done.`).first().waitFor({ state: "visible", timeout: 60_000 })
    }
    const rail = page.getByRole("navigation", { name: UI.rail })
    const visit = async (id: string) => {
      const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${id}"]`)
      while (!(await row.isVisible())) await rail.getByRole("button", { name: "Load more" }).first().click()
      await row.click()
      await page.waitForURL(new RegExp(id))
      await page.getByRole("textbox", { name: UI.composer }).waitFor({ state: "visible", timeout: 30_000 })
    }
    for (const id of [...extras, alpha]) await visit(id)
    await page.getByText(`Seed turn ${SEED_TURNS} done.`).first().waitFor({ state: "visible", timeout: 60_000 })

    await sendPrompt(page, `Write the long report A. ${acpScriptToken("stream-a")}`)
    await page.getByText("Streaming report").first().waitFor({ state: "visible", timeout: 30_000 })
    await visit(bravo)
    await page.getByText(`Seed turn ${SEED_TURNS} done.`).first().waitFor({ state: "visible", timeout: 30_000 })
    await sendPrompt(page, `Write the long report B. ${acpScriptToken("stream-b")}`)
    await page.getByText("Streaming report").first().waitFor({ state: "visible", timeout: 30_000 })
    console.log(`[third] alpha ${alpha} and bravo ${bravo} streaming`)
    if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE })

    const video = VIDEO ? recordScreen(bounds, path.join(OUT, "screen.mov"), Math.ceil(WATCH_MS / 1000) + 8) : undefined
    await page.evaluate(() => (window as unknown as { __switchProbe: { start(): void } }).__switchProbe.start())
    const samples: unknown[] = [await snapshot(page)]
    await page.getByRole("main").getByRole("button", { name: UI.newSession, exact: true }).click()
    await page.waitForURL(new RegExp(`${sessionRoute(workspace.id)}$`))
    samples.push(await snapshot(page))
    const picker = page.locator('[data-action="prompt-harness-model"]').filter({ visible: true })
    console.log(`[third] draft harness ${await picker.getAttribute("data-harness")}`)
    if (process.env.C_HARNESS !== "default" && (await picker.getAttribute("data-harness")) !== "scripted-acp") {
      await picker.click()
      await page.getByRole("button", { name: /^Harness/ }).click()
      await page.getByRole("button", { name: "Scripted ACP" }).click()
      await page.keyboard.press("Escape")
    }
    samples.push(await snapshot(page))
    const sentAt = Date.now()
    await sendPrompt(page, `Write the long report C. ${acpScriptToken("stream-c")}`)
    const shots: string[] = []
    const released = C_HOLD_MS > 0 ? setTimeout(() => void surface.release("c-boot"), C_HOLD_MS) : undefined
    for (let tick = 0; Date.now() - sentAt < WATCH_MS; tick += 1) {
      samples.push({ wall: Date.now() - sentAt, ...(await snapshot(page)) })
      if (tick % 4 === 0) {
        const file = `c-${String(Date.now() - sentAt).padStart(5, "0")}.png`
        await page.screenshot({ path: path.join(OUT, file) })
        shots.push(file)
      }
      await dwell(250)
    }
    clearTimeout(released)
    const probe = await page.evaluate(() => (window as unknown as { __switchProbe: { stop(): unknown } }).__switchProbe.stop())
    await video?.done
    const sessions = await api.sessions(workspace.directory)
    const created = sessions.filter((row) => row.id !== alpha && row.id !== bravo)
    const server = await Promise.all(
      created.map(async (row) => {
        const messages = await api.messages(workspace.directory, row.id)
        return { id: row.id, title: row.title, messages: messages.map((message) => ({ role: message.info.role, parts: message.parts.length, chars: JSON.stringify(message.parts).length })) }
      }),
    )
    await fs.writeFile(path.join(OUT, "third.json"), JSON.stringify({ target: TARGET, videoStartedAt: video?.startedAt, bounds, alpha, bravo, created: server, samples, shots, errors, probe }, null, 1))
    console.log(`[third] created ${JSON.stringify(server.map((row) => ({ id: row.id, messages: row.messages.length })))}`)
    console.log(`[third] final url ${page.url()}`)
    console.log(`[third] final slots ${JSON.stringify((samples.at(-1) as { slots: unknown }).slots)}`)
    console.log(`[third] ${errors.length} console errors; out ${OUT}`)
  } finally {
    await surface.close()
  }
}

await main()
