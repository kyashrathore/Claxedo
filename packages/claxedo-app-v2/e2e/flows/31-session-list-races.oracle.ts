import type { Page } from "@playwright/test"
import { appChoice, expect, type ClaxedoApi, type Stack } from "../harness"

type RailRow = { readonly sessionId: string; readonly title: string; readonly status: string }
type ListItem = { readonly sessionId: string; readonly title: string }
type Bounds = { readonly through?: string; readonly timeout?: number }
type CaseRail = { readonly rows: RailRow[]; readonly ids: ReadonlySet<string> }

export type Checked = {
  readonly stack: Stack
  readonly api: ClaxedoApi
  readonly directory: string
  readonly directories: readonly string[]
  readonly known: Set<string>
}

export const PAGE_SIZE = 50
const SERVER_PAGE = 100
const STATUS_COMPARED = appChoice() === "v2"

export function railLinks(app: Page) {
  return app.getByRole("region", { name: "Sessions" }).getByRole("link")
}

export async function railRows(app: Page): Promise<RailRow[]> {
  if (!STATUS_COMPARED) {
    return await app.getByTestId("rail-sidebar-session-row").evaluateAll((rows) =>
      rows.map((row) => ({
        sessionId: row.getAttribute("data-session-id") ?? "",
        title: row.querySelector("[data-slot=session-navigation-title]")?.textContent?.trim() ?? "",
        status: "",
      })),
    )
  }
  const list = app.getByRole("region", { name: "Sessions" }).getByRole("list")
  if ((await list.count()) === 0) return []
  return await list.evaluate(scrollVirtualRows)
}

async function scrollVirtualRows(list: Element): Promise<RailRow[]> {
  const scroller = list.parentElement
  if (!scroller) return []
  const painted = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const seen = new Map<string, RailRow>()
  scroller.scrollTop = 0
  await painted()
  for (;;) {
    for (const link of list.querySelectorAll("a[data-session-id]")) {
      const sessionId = link.getAttribute("data-session-id") ?? ""
      const status = link.querySelector("[role=img]")?.getAttribute("aria-label") ?? ""
      if (!seen.has(sessionId)) seen.set(sessionId, { sessionId, title: link.textContent?.trim() ?? "", status })
    }
    const before = scroller.scrollTop
    scroller.scrollTop = before + scroller.clientHeight
    if (scroller.scrollTop === before) break
    await painted()
  }
  scroller.scrollTop = 0
  return [...seen.values()]
}

async function listHeight(app: Page): Promise<number> {
  return await app.getByRole("region", { name: "Sessions" }).getByRole("list").evaluate((list) => list.scrollHeight)
}

export async function loadEveryPage(app: Page) {
  const more = app.getByRole("button", { name: "Load more" })
  while (await more.isVisible()) {
    const before = await listHeight(app)
    await more.click()
    await expect.poll(() => listHeight(app), { message: "a page of rows landed" }).toBeGreaterThan(before)
  }
}

async function listPage(stack: Stack, cursor: string | undefined): Promise<{ items: ListItem[]; nextCursor?: string }> {
  const url = new URL("/api/claxedo/session-list", stack.url)
  url.searchParams.set("scope", "workspace")
  url.searchParams.set("sort", "human_turn_desc")
  url.searchParams.set("limit", String(SERVER_PAGE))
  if (cursor) url.searchParams.set("cursor", cursor)
  const body = (await (await fetch(url)).json()) as { items?: ListItem[]; nextCursor?: string }
  return { items: body.items ?? [], nextCursor: body.nextCursor }
}

async function serverWindow(stack: Stack, through: string | undefined): Promise<ListItem[]> {
  const items: ListItem[] = []
  let cursor: string | undefined
  do {
    const page = await listPage(stack, cursor)
    items.push(...page.items)
    cursor = page.nextCursor
    const end = through === undefined ? PAGE_SIZE : items.findIndex((item) => item.sessionId === through) + 1
    if (end > 0 && end <= items.length) return items.slice(0, end)
  } while (cursor)
  return items
}

export async function caseOrder(checked: Checked): Promise<string[]> {
  const items: ListItem[] = []
  let cursor: string | undefined
  do {
    const page = await listPage(checked.stack, cursor)
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items.filter((item) => checked.known.has(item.sessionId)).map((item) => item.sessionId)
}

function statusLabel(wire: string | undefined, waiting: boolean, lastTurnFailed: boolean): string {
  if (!STATUS_COMPARED) return ""
  if (waiting) return "Waiting on you"
  if (wire === "busy") return "Working"
  if (wire === "retry") return "Retrying"
  if (wire === "recovering") return "Recovering"
  return lastTurnFailed ? "Failed" : "Idle"
}

async function workspaceFacts(api: ClaxedoApi, directory: string) {
  const [statuses, permissions, questions, sessions] = await Promise.all([
    api.status(directory),
    api.permissions(directory),
    api.questions(directory),
    api.sessions(directory),
  ])
  return { statuses, requests: [...permissions, ...questions], sessions }
}

async function caseFacts(checked: Checked) {
  const facts = await Promise.all(checked.directories.map((directory) => workspaceFacts(checked.api, directory)))
  const statuses = Object.assign({}, ...facts.map((fact) => fact.statuses)) as Record<string, { type: string }>
  const sessions = facts.flatMap((fact) => fact.sessions)
  const waiting = new Set(facts.flatMap((fact) => fact.requests).map((request) => request.sessionID))
  const failed = new Set(sessions.filter((row) => (row.lastTurn as { status?: string } | undefined)?.status === "failed").map((row) => row.id))
  return {
    ids: new Set([...checked.known, ...sessions.map((row) => row.id)]),
    statusOf: (sessionId: string) => statusLabel(statuses[sessionId]?.type, waiting.has(sessionId), failed.has(sessionId)),
  }
}

async function serverRail(checked: Checked, bounds: Bounds = {}): Promise<CaseRail> {
  const [items, facts] = await Promise.all([serverWindow(checked.stack, bounds.through), caseFacts(checked)])
  const rows = items
    .filter((item) => facts.ids.has(item.sessionId))
    .map((item) => ({ sessionId: item.sessionId, title: item.title, status: facts.statusOf(item.sessionId) }))
  return { rows, ids: facts.ids }
}

export async function expectRailEqualsServer(app: Page, checked: Checked, bounds: Bounds = {}): Promise<readonly RailRow[]> {
  let matched: readonly RailRow[] = []
  const compare = async () => {
    const [visible, server] = await Promise.all([railRows(app), serverRail(checked, bounds)])
    const mine = visible.filter((row) => server.ids.has(row.sessionId))
    matched = mine
    return JSON.stringify(mine) === JSON.stringify(server.rows) ? "equal" : JSON.stringify({ visible: mine, server: server.rows }, null, 1)
  }
  const message = "the rail's rows equal the server's list and statuses, row by row"
  await expect.poll(compare, { message, timeout: bounds.timeout }).toBe("equal")
  return matched
}

export async function expectServerStatus(checked: Checked, sessionId: string, label: string) {
  const status = async () => (await caseFacts(checked)).statusOf(sessionId)
  await expect.poll(status, { message: `the server reports ${label}` }).toBe(STATUS_COMPARED ? label : "")
}
