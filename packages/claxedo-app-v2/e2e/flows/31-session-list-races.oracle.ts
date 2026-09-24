import type { Page, Route } from "@playwright/test"
import {
  acpScriptToken,
  appChoice,
  expect,
  SCRIPTED_ACP_HARNESS,
  test,
  type AcpStep,
  type ClaxedoApi,
  type Stack,
  type Workspace,
} from "../harness"

type RailRow = { readonly sessionId: string; readonly title: string; readonly status: string }
type ListItem = { readonly sessionId: string; readonly title: string }
type Checked = { readonly stack: Stack; readonly api: ClaxedoApi; readonly directory: string }
type Bounds = { readonly through?: string; readonly timeout?: number }

const LIST_ROUTE = /\/api\/claxedo\/session-list/
export const STREAM_PATH = "/api/wr/events"
export const PAGE_SIZE = 50
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
    scroller.scrollTop = before + scroller.clientHeight / 2
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

export async function serverItems(stack: Stack): Promise<ListItem[]> {
  const items: ListItem[] = []
  let cursor: string | undefined
  do {
    const url = new URL("/api/claxedo/session-list", stack.url)
    url.searchParams.set("scope", "workspace")
    url.searchParams.set("sort", "human_turn_desc")
    url.searchParams.set("limit", String(PAGE_SIZE))
    if (cursor) url.searchParams.set("cursor", cursor)
    const body = (await (await fetch(url)).json()) as { items?: ListItem[]; nextCursor?: string }
    items.push(...(body.items ?? []))
    cursor = body.nextCursor
  } while (cursor)
  return items
}

function statusLabel(wire: string | undefined, waiting: boolean, lastTurnFailed: boolean): string {
  if (!STATUS_COMPARED) return ""
  if (waiting) return "Waiting on you"
  if (wire === "busy") return "Working"
  if (wire === "retry") return "Retrying"
  if (wire === "recovering") return "Recovering"
  return lastTurnFailed ? "Failed" : "Idle"
}

async function serverRail({ stack, api, directory }: Checked, bounds: Bounds = {}): Promise<RailRow[]> {
  const [items, statuses, permissions, questions, sessions] = await Promise.all([
    serverItems(stack),
    api.status(directory),
    api.permissions(directory),
    api.questions(directory),
    api.sessions(directory),
  ])
  const waiting = new Set([...permissions, ...questions].map((request) => request.sessionID))
  const failed = new Set(sessions.filter((row) => (row.lastTurn as { status?: string } | undefined)?.status === "failed").map((row) => row.id))
  const end = bounds.through ? items.findIndex((item) => item.sessionId === bounds.through) + 1 : PAGE_SIZE
  return items.slice(0, end || items.length).map((item) => ({
    sessionId: item.sessionId,
    title: item.title,
    status: statusLabel(statuses[item.sessionId]?.type, waiting.has(item.sessionId), failed.has(item.sessionId)),
  }))
}

export async function expectRailEqualsServer(app: Page, checked: Checked, bounds: Bounds = {}) {
  const compare = async () => {
    const [visible, server] = await Promise.all([railRows(app), serverRail(checked, bounds)])
    return JSON.stringify(visible) === JSON.stringify(server) ? "equal" : JSON.stringify({ visible, server }, null, 1)
  }
  const message = "the rail's rows equal the server's list and statuses, row by row"
  await expect.poll(compare, { message, timeout: bounds.timeout }).toBe("equal")
}

export async function expectServerStatus(checked: Checked, sessionId: string, label: string) {
  const status = async () => (await serverRail(checked, { through: sessionId })).find((row) => row.sessionId === sessionId)?.status
  await expect.poll(status, { message: `the server reports ${label}` }).toBe(STATUS_COMPARED ? label : "")
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export async function holdListRead(app: Page, matches: (url: URL) => boolean = () => true) {
  const computed = deferred<void>()
  const released = deferred<void>()
  const delivered = deferred<PromiseSettledResult<void>>()
  let captured = false
  const handler = async (route: Route) => {
    if (captured || !matches(new URL(route.request().url()))) return await route.fallback()
    captured = true
    const response = await route.fetch()
    computed.resolve()
    await released.promise
    const [outcome] = await Promise.allSettled([route.fulfill({ response })])
    delivered.resolve(outcome)
  }
  await app.route(LIST_ROUTE, handler)
  return {
    computed: computed.promise,
    release: async () => {
      released.resolve()
      const outcome = await delivered.promise
      if (outcome.status === "rejected") test.info().annotations.push({ type: "abandoned list read", description: String(outcome.reason) })
      expect(outcome.status, "the app received the held list read").toBe("fulfilled")
    },
  }
}

export async function reopenHoldingListRead(app: Page, stack: Stack) {
  await app.goto("about:blank")
  const read = await holdListRead(app)
  await app.goto(`${stack.url}/`)
  await read.computed
  return read
}

export async function watchBrowserStream(app: Page) {
  const cdp = await app.context().newCDPSession(app)
  const streams = new Set<string>()
  let text = ""
  const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8")
  cdp.on("Network.responseReceived", (event) => {
    if (!event.response.url.includes(STREAM_PATH)) return
    streams.add(event.requestId)
    void cdp.send("Network.streamResourceContent", { requestId: event.requestId }).then((result) => {
      text += decode(result.bufferedData)
    })
  })
  cdp.on("Network.dataReceived", (event) => {
    if (streams.has(event.requestId) && event.data) text += decode(event.data)
  })
  await cdp.send("Network.enable")
  const received = async (marker: string) => {
    await expect.poll(() => text.includes(marker), { message: `the app's own stream carried "${marker}"` }).toBe(true)
  }
  return { received }
}

export async function patchSession(checked: Checked, id: string, body: Record<string, unknown>) {
  const url = new URL(`/session/${encodeURIComponent(id)}`, checked.stack.url)
  url.searchParams.set("directory", checked.directory)
  const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  expect(response.ok, `PATCH /session/${id} answered ${response.status}`).toBe(true)
}

export async function startHeldTurn(checked: Checked, sessionId: string, hold: string, steps: AcpStep[] = []) {
  await checked.stack.acp.write(hold, { steps: [{ kind: "hold", name: hold }, ...steps, { kind: "text", text: `${hold} finished` }] })
  await checked.api.promptAsync(checked.directory, sessionId, `Run ${acpScriptToken(hold)}`)
}

async function createProject(stack: Stack, directory: string) {
  const response = await fetch(new URL("/api/claxedo/projects", stack.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Races", source: { kind: "directory", directory } }),
  })
  expect(response.status, "the project was created").toBe(201)
}

export async function setup(stack: Stack, api: ClaxedoApi, app: Page, titles: readonly string[]) {
  const workspace: Workspace = await stack.daemon.makeWorkspace("races")
  await createProject(stack, workspace.directory)
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const sessions = [await create(titles[0])]
  for (let start = 1; start < titles.length; start += 20) {
    sessions.push(...(await Promise.all(titles.slice(start, start + 20).map(create))))
  }
  await app.goto(`${stack.url}/`)
  return { sessions, checked: { stack, api, directory: workspace.directory } }
}
