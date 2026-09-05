import { measurement } from "../../isolated-interaction"
import type { FlowResult } from "../../flows"
import { measureInteraction } from "../../frame-sampler"
import { launchTo, recordVisualFailure, settleForVideo } from "../actions/common"
import { waitForTranscript } from "../actions/session"
import { navigateToTerminalRoute, openTerminalSurface } from "../actions/terminal"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page } from "playwright-core"

export async function liveTerminalSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const session = fixture.sessions[0]
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  await navigateToTerminalRoute(page, app, fixture, fixture.terminals[0], true)
  await navigateToTerminalRoute(page, app, fixture, fixture.terminals[1], false)
  await openTerminalSurface(page, fixture, fixture.terminals[0])
  await openTerminalSurface(page, fixture, fixture.terminals[1])
  let switchMs = 0
  // Headline: switching among already-open terminal surfaces. The fixture
  // proves websocket attachment with one seeded line; continuous output stress
  // belongs in a separate flow.
  const headline = await measureInteraction(page, "live-terminal-switch", async () => {
    switchMs = await measureInPageTerminalSwitch(page, fixture.terminals[0].id)
    await measureInPageTerminalSwitch(page, fixture.terminals[1].id)
    await measureInPageTerminalSwitch(page, fixture.terminals[0].id)
  })
  if (switchMs >= 4_900) recordVisualFailure(fixture, "terminal switch did not settle before timeout")
  await settleForVideo(page)
  const resizeMs = await measureInPageTerminalResize(page, { width: 1320, height: 860 })
  return {
    headline,
    debug: [
      measurement("terminal_switch_ms", Math.round(switchMs * 100) / 100),
      measurement("terminal_resize_ms", resizeMs),
    ],
  }
}

async function measureInPageTerminalResize(page: Page, size: { width: number; height: number }): Promise<number> {
  await page.evaluate(() => {
    ;(window as unknown as { __claxedoResizeStart?: number }).__claxedoResizeStart = undefined
    const handler = () => {
      const w = window as unknown as { __claxedoResizeStart?: number }
      if (w.__claxedoResizeStart === undefined) w.__claxedoResizeStart = performance.now()
    }
    window.addEventListener("resize", handler, { once: true })
  })
  await page.setViewportSize(size)
  return await page.evaluate(async () => {
    const w = window as unknown as { __claxedoResizeStart?: number }
    const start = w.__claxedoResizeStart ?? performance.now()
    const fits = (r: DOMRect) => r.width > 100 && r.height > 40
    return await new Promise<number>((resolve) => {
      let stableFrames = 0
      let last = ""
      const limit = 1000
      const tick = () => {
        const elapsed = performance.now() - start
        const els = Array.from(document.querySelectorAll("[data-component='terminal']"))
        const sig = els
          .map((el) => {
            const r = el.getBoundingClientRect()
            return `${Math.round(r.width)}x${Math.round(r.height)}`
          })
          .join("|")
        const hasVisible = els.some((el) => fits(el.getBoundingClientRect()))
        if (hasVisible && sig === last) {
          stableFrames++
          if (stableFrames >= 2) return resolve(elapsed)
        } else {
          stableFrames = 0
          last = sig
        }
        if (elapsed > limit) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
}

async function measureInPageTerminalSwitch(page: Page, terminalId: string): Promise<number> {
  return await page.evaluate(async (id) => {
    const sidebar = document.querySelector("[data-testid='terminal-section']")
    if (!sidebar) return 5000
    const target = sidebar.querySelector<HTMLElement>(
      `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${CSS.escape(id)}"]`,
    )
    if (!target) return 5000
    const start = performance.now()
    // Same NavigationRow shape as the session rows: the activate handler is
    // on the absolute child button, not the row container.
    ;(target.querySelector<HTMLElement>('[data-slot="navigation-row-activate"]') ?? target).click()

    return await new Promise<number>((resolve) => {
      const limit = 5000
      let stableReadyFrames = 0
      const tick = () => {
        const elapsed = performance.now() - start
        const current = document.querySelector<HTMLElement>(
          `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${CSS.escape(id)}"]`,
        )
        const pane = document.querySelector<HTMLElement>(
          `[data-testid="terminal-pane"][data-terminal-id="${CSS.escape(id)}"]`,
        )
        const ready = current?.dataset.active === "true" && !!pane && !pane.closest("[aria-hidden='true']")
        stableReadyFrames = ready ? stableReadyFrames + 1 : 0
        if (stableReadyFrames >= 2) return resolve(elapsed)
        if (elapsed > limit) return resolve(elapsed)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, terminalId)
}
