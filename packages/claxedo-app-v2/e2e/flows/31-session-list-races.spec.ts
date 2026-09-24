import type { APIResponse, Page, Route } from "@playwright/test"
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
const STREAM_PATH = "/api/wr/events"
const PAGE_SIZE = 50
const STATUS_COMPARED = appChoice() === "v2"

test.skip(({ isMobile }) => isMobile, "Flow 31 runs at desktop width; flow 33 owns the phone rail")

function railLinks(app: Page) {
  return app.getByRole("region", { name: "Sessions" }).getByRole("link")
}

async function railRows(app: Page): Promise<RailRow[]> {
  if (!STATUS_COMPARED) {
    return await app.getByTestId("rail-sidebar-session-row").evaluateAll((rows) =>
      rows.map((row) => ({
        sessionId: row.getAttribute("data-session-id") ?? "",
        title: row.querySelector("[data-slot=session-navigation-title]")?.textContent?.trim() ?? "",
        status: "",
      })),
    )
  }
  return await railLinks(app).evaluateAll((links) =>
    links.map((link) => ({
      sessionId: link.getAttribute("data-session-id") ?? "",
      title: link.textContent?.trim() ?? "",
      status: link.querySelector("[role=img]")?.getAttribute("aria-label") ?? "",
    })),
  )
}

async function serverItems(stack: Stack): Promise<ListItem[]> {
  const items: ListItem[] = []
  let cursor: string | undefined
  do {
    const url = new URL("/api/claxedo/session-list", stack.url)
    url.searchParams.set("scope", "project")
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

async function expectRailEqualsServer(app: Page, checked: Checked, bounds: Bounds = {}) {
  const compare = async () => {
    const [visible, server] = await Promise.all([railRows(app), serverRail(checked, bounds)])
    return JSON.stringify(visible) === JSON.stringify(server) ? "equal" : JSON.stringify({ visible, server }, null, 1)
  }
  const message = "the rail's rows equal the server's list and statuses, row by row"
  await expect.poll(compare, { message, timeout: bounds.timeout }).toBe("equal")
}

async function expectServerStatus(checked: Checked, sessionId: string, label: string) {
  const status = async () => (await serverRail(checked)).find((row) => row.sessionId === sessionId)?.status
  await expect.poll(status, { message: `the server reports ${label}` }).toBe(STATUS_COMPARED ? label : "")
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function holdListRead(app: Page, matches: (url: URL) => boolean = () => true) {
  const held: { route: Route; response: APIResponse }[] = []
  const first = deferred<void>()
  const handler = async (route: Route) => {
    if (!matches(new URL(route.request().url()))) return await route.fallback()
    held.push({ route, response: await route.fetch() })
    first.resolve()
  }
  await app.route(LIST_ROUTE, handler)
  return {
    computed: first.promise,
    release: async () => {
      await app.unroute(LIST_ROUTE, handler)
      const settled = await Promise.allSettled(held.map(({ route, response }) => route.fulfill({ response })))
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "rejected") {
          test.info().annotations.push({ type: "abandoned list read", description: `${held[index].route.request().url()}: ${String(outcome.reason)}` })
        }
      }
      expect(settled.some((outcome) => outcome.status === "fulfilled"), "the app received a held list read").toBe(true)
    },
  }
}

async function reopenHoldingListRead(app: Page, stack: Stack) {
  await app.goto("about:blank")
  const read = await holdListRead(app)
  await app.goto(`${stack.url}/`)
  await read.computed
  return read
}

async function watchBrowserStream(app: Page) {
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

async function patchSession(checked: Checked, id: string, body: Record<string, unknown>) {
  const url = new URL(`/session/${encodeURIComponent(id)}`, checked.stack.url)
  url.searchParams.set("directory", checked.directory)
  const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  expect(response.ok, `PATCH /session/${id} answered ${response.status}`).toBe(true)
}

async function startHeldTurn(checked: Checked, sessionId: string, hold: string, steps: AcpStep[] = []) {
  await checked.stack.acp.write(hold, { steps: [{ kind: "hold", name: hold }, ...steps, { kind: "text", text: `${hold} finished` }] })
  await checked.api.promptAsync(checked.directory, sessionId, `Run ${acpScriptToken(hold)}`)
}

async function setup(stack: Stack, api: ClaxedoApi, app: Page, titles: readonly string[]) {
  const workspace: Workspace = await stack.daemon.makeWorkspace("races")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const sessions = [await create(titles[0])]
  for (let start = 1; start < titles.length; start += 20) {
    sessions.push(...(await Promise.all(titles.slice(start, start + 20).map(create))))
  }
  await app.goto(`${stack.url}/`)
  return { sessions, checked: { stack, api, directory: workspace.directory } }
}

test("31 an event arrives before the list response", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race quiet", "Race renamed", "Race working", "Race fence"])
  const [, renamed, working, fence] = sessions
  const stream = await watchBrowserStream(app)
  const read = await reopenHoldingListRead(app, stack)
  await patchSession(checked, renamed.id, { title: "Race renamed during the read" })
  await startHeldTurn(checked, working.id, "working-during-read")
  await api.createSession(checked.directory, { title: "Race created during the read", harness: SCRIPTED_ACP_HARNESS })
  await expectServerStatus(checked, working.id, "Working")
  await patchSession(checked, fence.id, { title: "Race fence one" })
  await stream.received("Race fence one")
  await read.release()
  await expectRailEqualsServer(app, checked)
})

test("31 a delete lands during a fetch", async ({ stack, api, app }) => {
  const { checked } = await setup(stack, api, app, Array.from({ length: PAGE_SIZE + 5 }, (_, index) => `Race row ${index}`))
  const order = (await serverItems(stack)).map((item) => item.sessionId)
  const stream = await watchBrowserStream(app)
  const first = await reopenHoldingListRead(app, stack)
  await api.deleteSession(checked.directory, order[1])
  await patchSession(checked, order[2], { title: "Race fence first page" })
  await stream.received("Race fence first page")
  await first.release()
  await expectRailEqualsServer(app, checked, { through: order[PAGE_SIZE - 1] })
  const more = await holdListRead(app, (url) => url.searchParams.has("cursor"))
  await app.getByRole("button", { name: "Load more" }).click()
  await more.computed
  await api.deleteSession(checked.directory, order[3])
  await api.deleteSession(checked.directory, order[PAGE_SIZE + 2])
  await patchSession(checked, order[4], { title: "Race fence second page" })
  await stream.received("Race fence second page")
  await more.release()
  await expectRailEqualsServer(app, checked, { through: order[PAGE_SIZE + 4] })
})

test("31 another browser creates a session", async ({ stack, api, app, browser }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race first", "Race second"])
  await expectRailEqualsServer(app, checked)
  const other = await (await browser.newContext()).newPage()
  await other.goto(`${stack.url}/`)
  await railLinks(other).filter({ hasText: sessions[0].title }).click()
  await other.getByRole("button", { name: "New session" }).click()
  await expect.poll(async () => (await serverItems(stack)).length, { message: "the server lists the new session" }).toBe(3)
  await expectRailEqualsServer(app, checked)
  await expectRailEqualsServer(other, checked)
  await other.context().close()
})

test("31 the app reconnects after missed events", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race kept", "Race gone", "Race retitled", "Race prompted"])
  await expectRailEqualsServer(app, checked)
  const isStream = (url: URL) => url.pathname.endsWith(STREAM_PATH)
  await app.route(isStream, (route) => route.abort())
  await stack.daemon.restart()
  await api.deleteSession(checked.directory, sessions[1].id)
  await patchSession(checked, sessions[2].id, { title: "Race retitled while away" })
  await stack.acp.write("away", { steps: [{ kind: "text", text: "Answered while away" }] })
  await api.prompt(checked.directory, sessions[3].id, `Hello ${acpScriptToken("away")}`)
  await api.createSession(checked.directory, { title: "Race created while away", harness: SCRIPTED_ACP_HARNESS })
  await app.unroute(isStream)
  await expectRailEqualsServer(app, checked, { timeout: 30_000 })
})

test("31 statuses follow the turn: working, waiting on you, working, idle, and failed", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race lifecycle", "Race failing"])
  const [lifecycle, failing] = sessions
  await expectRailEqualsServer(app, checked)
  const permission: AcpStep = { kind: "permission", tool: "edit", title: "Edit the notes", path: `${checked.directory}/notes.md` }
  await startHeldTurn(checked, lifecycle.id, "lifecycle", [permission, { kind: "hold", name: "after-permission" }])
  const expectStep = async (label: string) => {
    await expectServerStatus(checked, lifecycle.id, label)
    await expectRailEqualsServer(app, checked)
  }
  await expectStep("Working")
  await stack.acp.release("lifecycle")
  await expectStep("Waiting on you")
  const [request] = await api.permissions(checked.directory)
  await api.replyPermission(checked.directory, lifecycle.id, request.id, "once")
  await expectStep("Working")
  await stack.acp.release("after-permission")
  await expectStep("Idle")
  await stack.acp.write("failing", { steps: [{ kind: "error", message: "Scripted turn failure" }] })
  await api.promptAsync(checked.directory, failing.id, `Fail ${acpScriptToken("failing")}`)
  await expectServerStatus(checked, failing.id, "Failed")
  await expectRailEqualsServer(app, checked)
})

test("31 a session is archived, renamed or deleted while a turn runs", async ({ stack, api, app }) => {
  const { sessions, checked } = await setup(stack, api, app, ["Race archive me", "Race rename me", "Race delete me", "Race bystander"])
  const [archived, renamed, deleted] = sessions
  const holds = ["archive-turn", "rename-turn", "delete-turn"]
  for (const [index, hold] of holds.entries()) await startHeldTurn(checked, sessions[index].id, hold)
  for (const session of [archived, renamed, deleted]) await expectServerStatus(checked, session.id, "Working")
  await expectRailEqualsServer(app, checked)
  await patchSession(checked, archived.id, { time: { archived: Date.now() } })
  await patchSession(checked, renamed.id, { title: "Race renamed mid-turn" })
  await expect(api.deleteSession(checked.directory, deleted.id), "the server refuses to delete running work").rejects.toMatchObject({ status: 409 })
  await expectRailEqualsServer(app, checked)
  for (const hold of holds) await stack.acp.release(hold)
  await expectServerStatus(checked, deleted.id, "Idle")
  await api.deleteSession(checked.directory, deleted.id)
  await expectServerStatus(checked, renamed.id, "Idle")
  await expectRailEqualsServer(app, checked)
})
