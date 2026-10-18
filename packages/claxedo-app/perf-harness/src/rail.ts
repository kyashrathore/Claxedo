import { isStringList } from "@claxedo/helpers/guards"
import { readField, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import type { CdpPage } from "./cdp-page"
import type { ReadinessTarget } from "./corpus"

export type Point = { x: number; y: number }

type RevealStep = { kind: "row"; point: Point } | { kind: "load-more"; point: Point; rows: number } | { kind: "wait"; reason: string }

export type RevealScope = { projectId: string | undefined }

const LOAD_MORE_RETRY_MS = 1_000

function readPoint(value: unknown): Point | undefined {
  const x = readFiniteNumber(value, "x")
  const y = readFiniteNumber(value, "y")
  return x === undefined || y === undefined ? undefined : { x, y }
}

function readRevealStep(value: unknown): RevealStep {
  const kind = readString(value, "kind")
  const point = readPoint(readField(value, "point"))
  const rows = readFiniteNumber(value, "rows")
  const reason = readString(value, "reason")
  if (kind === "row" && point) return { kind, point }
  if (kind === "load-more" && point && rows !== undefined) return { kind, point, rows }
  if (kind === "wait" && reason !== undefined) return { kind, reason }
  throw new Error(`Claxedo's rail reported a malformed reveal step: ${JSON.stringify(value)}`)
}

export async function trustedClick(page: CdpPage, point: Point) {
  await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
  await page.command("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
  await page.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
}

async function nextRevealStep(page: CdpPage, sessionId: string, scope: RevealScope) {
  return readRevealStep(await page.evaluate((arg: { sessionId: string; projectId: string | null }): RevealStep => {
    const hitPoint = (element: HTMLElement) => {
      element.scrollIntoView({ block: "center", behavior: "instant" })
      const rect = element.getBoundingClientRect()
      const point = { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 }
      const hit = document.elementFromPoint(point.x, point.y)
      return hit && element.contains(hit) ? point : undefined
    }
    const row = document.querySelector<HTMLElement>(`[data-slot="session-navigation-row"][data-session-id="${CSS.escape(arg.sessionId)}"] [data-slot="navigation-row-activate"]`)
    if (row) {
      const point = hitPoint(row)
      return point ? { kind: "row", point } : { kind: "wait", reason: "row covered" }
    }
    const container = document.querySelector<HTMLElement>('[data-testid="activity-sessions"]')
      ?? (arg.projectId ? document.querySelector<HTMLElement>(`[data-testid="project-group"][data-project-id="${CSS.escape(arg.projectId)}"]`) : null)
    const more = container?.querySelector<HTMLElement>('[data-testid="rail-sidebar-session-load-more"]')
    if (!more || more.hasAttribute("disabled") || more.getAttribute("aria-busy") === "true") return { kind: "wait", reason: container ? "list loading" : "no list" }
    const point = hitPoint(more)
    const rows = document.querySelectorAll('[data-slot="session-navigation-row"]').length
    return point ? { kind: "load-more", point, rows } : { kind: "wait", reason: "load more covered" }
  }, { sessionId, projectId: scope.projectId ?? null }))
}

export async function revealSessionRow(page: CdpPage, target: ReadinessTarget, scope: RevealScope, timeoutMs: number): Promise<Point> {
  const deadline = performance.now() + timeoutMs
  let lastReason = ""
  let pressed = { rows: -1, at: 0 }
  while (performance.now() < deadline) {
    const step = await nextRevealStep(page, target.sessionId, scope)
    if (step.kind === "row") return step.point
    if (step.kind === "load-more" && (step.rows > pressed.rows || performance.now() - pressed.at > LOAD_MORE_RETRY_MS)) {
      await trustedClick(page, step.point)
      pressed = { rows: step.rows, at: performance.now() }
    }
    if (step.kind === "wait") lastReason = step.reason
    await Bun.sleep(8)
  }
  throw new Error(`Claxedo never listed ${target.logicalSessionId} in its rail (${lastReason})`)
}

export async function listedSessionIds(page: CdpPage) {
  const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-slot="session-navigation-row"]')].map((row) => row.dataset.sessionId ?? ""))
  if (!isStringList(rows)) throw new Error(`Claxedo's rail reported malformed session ids: ${JSON.stringify(rows)}`)
  return rows
}

function readMenuPoint(value: unknown) {
  if (value === null) return undefined
  const point = readPoint(value)
  if (!point) throw new Error(`Claxedo's menu reported a malformed item position: ${JSON.stringify(value)}`)
  return { ...point, checked: readString(value, "checked") }
}

async function menuPoint(page: CdpPage, selector: string, text?: string) {
  return readMenuPoint(await page.evaluate((arg: { selector: string; text: string | null }) => {
    const element = [...document.querySelectorAll<HTMLElement>(arg.selector)].find((item) => arg.text === null || item.innerText.trim() === arg.text)
    if (!element) return null
    element.scrollIntoView({ block: "center", behavior: "instant" })
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, checked: element.getAttribute("aria-checked") }
  }, { selector, text: text ?? null }))
}

export async function chooseActivityView(page: CdpPage, timeoutMs: number) {
  await page.waitFor(() => !!document.querySelector('button[aria-label="Session options"]'), undefined, timeoutMs, "the session options button")
  const options = await menuPoint(page, 'button[aria-label="Session options"]')
  if (!options) throw new Error("Claxedo has no session options button")
  await trustedClick(page, options)
  await page.waitFor(() => !!document.querySelector('[role="menuitemradio"]'), undefined, timeoutMs, "the session options menu")
  const activity = await menuPoint(page, '[role="menuitemradio"]', "Activity")
  if (!activity) throw new Error("Claxedo's session options offer no Activity view")
  if (activity.checked !== "true") await trustedClick(page, activity)
  else {
    for (const type of ["keyDown", "keyUp"]) await page.command("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  }
  await page.waitFor(() => !!document.querySelector('[data-testid="activity-sessions"]') && !document.querySelector('[role="menuitemradio"]'), undefined, timeoutMs, "the Activity view")
}
