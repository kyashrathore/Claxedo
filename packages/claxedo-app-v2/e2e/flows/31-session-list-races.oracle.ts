import type { Page } from "@playwright/test"
import { expect, type ClaxedoApi, type Stack } from "../harness"

type RailRow = { readonly sessionId: string; readonly title: string; readonly status: string }
type ListItem = { readonly sessionId: string; readonly title: string }
type Bounds = { readonly timeout?: number }

export type Checked = {
  readonly stack: Stack
  readonly api: ClaxedoApi
  readonly directory: string
  readonly directories: readonly string[]
  readonly known: Set<string>
  readonly directoryOf: Map<string, string>
}

export const PAGE_SIZE = 5
const SERVER_PAGE = 100
const RAIL_STATUS: Readonly<Record<string, string>> = { permission: "Waiting on you", working: "Working" }
const SERVER_RAIL_STATUS: Readonly<Record<string, string>> = { "Waiting on you": "Waiting on you", Working: "Working", Retrying: "Working" }

export function railRow(app: Page, title: string) {
  return app.getByTestId("rail-sidebar-session-row").filter({ has: app.getByRole("button", { name: title, exact: true }) })
}

export async function railRows(app: Page): Promise<RailRow[]> {
  const rows = await app.getByTestId("rail-sidebar-session-row").evaluateAll((elements) =>
    elements.map((row) => ({
      sessionId: row.getAttribute("data-session-id") ?? "",
      title: row.querySelector(".ui-session-navigation-title")?.textContent?.trim() ?? "",
      mark: row.querySelector("[data-sidebar-status]")?.getAttribute("data-sidebar-status") ?? "",
    })),
  )
  return rows.map(({ sessionId, title, mark }) => ({ sessionId, title, status: RAIL_STATUS[mark] ?? "" }))
}

export async function loadPagesUntil(app: Page, sessionId: string) {
  const rows = app.getByTestId("rail-sidebar-session-row")
  const target = app.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionId}"]`)
  const more = app.locator('[data-testid="rail-sidebar-session-load-more"]:enabled')
  while ((await target.count()) === 0) {
    const before = await rows.count()
    await expect(more.first(), `a Load more button remains while ${sessionId} is not loaded`).toBeVisible()
    await more.first().click()
    await expect.poll(() => rows.count(), { message: "a page of rows landed" }).toBeGreaterThan(before)
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

async function serverList(stack: Stack): Promise<ListItem[]> {
  const items: ListItem[] = []
  let cursor: string | undefined
  do {
    const page = await listPage(stack, cursor)
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

export async function caseOrder(checked: Checked): Promise<string[]> {
  const items = await serverList(checked.stack)
  return items.filter((item) => checked.known.has(item.sessionId)).map((item) => item.sessionId)
}

function statusLabel(wire: string | undefined, waiting: boolean, lastTurnFailed: boolean): string {
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

function projectOf(checked: Checked, sessionId: string) {
  return checked.directoryOf.get(sessionId) ?? checked.directory
}

function loadedPages(rows: number) {
  return Math.max(PAGE_SIZE, Math.ceil(rows / PAGE_SIZE) * PAGE_SIZE)
}

async function expectedRail(checked: Checked, visible: readonly RailRow[]) {
  const [items, facts] = await Promise.all([serverList(checked.stack), caseFacts(checked)])
  const known = items.filter((item) => facts.ids.has(item.sessionId))
  return checked.directories.map((directory) => {
    const shown = visible.filter((row) => facts.ids.has(row.sessionId) && projectOf(checked, row.sessionId) === directory)
    const expected = known
      .filter((item) => projectOf(checked, item.sessionId) === directory)
      .slice(0, loadedPages(shown.length))
      .map((item) => ({ sessionId: item.sessionId, title: item.title, status: SERVER_RAIL_STATUS[facts.statusOf(item.sessionId)] ?? "" }))
    const bySession = (left: RailRow, right: RailRow) => left.sessionId.localeCompare(right.sessionId)
    return { shown: shown.toSorted(bySession), expected: expected.toSorted(bySession) }
  })
}

export async function expectRailEqualsServer(app: Page, checked: Checked, bounds: Bounds = {}): Promise<readonly RailRow[]> {
  let matched: readonly RailRow[] = []
  const compare = async () => {
    const visible = await railRows(app)
    const projects = await expectedRail(checked, visible)
    matched = visible.filter((row) => checked.directories.includes(projectOf(checked, row.sessionId)))
    const equal = projects.every((project) => JSON.stringify(project.shown) === JSON.stringify(project.expected))
    return equal ? "equal" : JSON.stringify(projects, null, 1)
  }
  const message = "each project's rail rows equal the server's list and statuses for the pages it loaded"
  await expect.poll(compare, { message, timeout: bounds.timeout }).toBe("equal")
  return matched
}

export async function expectServerStatus(checked: Checked, sessionId: string, label: string) {
  const status = async () => (await caseFacts(checked)).statusOf(sessionId)
  await expect.poll(status, { message: `the server reports ${label}` }).toBe(label)
}
