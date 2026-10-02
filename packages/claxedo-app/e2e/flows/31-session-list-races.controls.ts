import type { Page } from "@playwright/test"
import {
  acpScriptToken,
  expect,
  holdResponse,
  SCRIPTED_ACP_HARNESS,
  startStack,
  test as harnessTest,
  type AcpStep,
  type ClaxedoApi,
  type Stack,
  type Workspace,
} from "../harness"
import type { Checked } from "./31-session-list-races.oracle"

type SetupOptions = { readonly open?: boolean; readonly workspaces?: number }

const LIST_ROUTE = /\/api\/claxedo\/session-list/
export const STREAM_PATH = "/api/wr/events"
const CONTROL_STREAM_PATH = "/api/cp/events"

export const test = harnessTest.extend<{}, { sharedStack: Stack }>({
  sharedStack: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const stack = await startStack({ label: "31 session list races" })
      try {
        await use(stack)
      } finally {
        await stack.close()
      }
    },
    { scope: "worker" },
  ],
  stack: async ({ sharedStack }, use, testInfo) => {
    await use(sharedStack)
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("daemon.log", { body: sharedStack.daemon.log(), contentType: "text/plain" })
    }
  },
  app: async ({ page }, use) => {
    await use(page)
  },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function holdListRead(app: Page, matches: (url: URL) => boolean = () => true) {
  return holdResponse(app, LIST_ROUTE, matches)
}

export async function reopenHoldingListRead(app: Page, stack: Stack) {
  await app.goto("about:blank")
  const read = await holdListRead(app)
  await app.goto(`${stack.url}/`)
  await read.computed
  return read
}

export async function holdEventStreams(app: Page) {
  const released = deferred<void>()
  const isStream = (url: URL) => url.pathname.endsWith(STREAM_PATH) || url.pathname.endsWith(CONTROL_STREAM_PATH)
  await app.route(isStream, async (route) => {
    await released.promise
    await route.continue()
  })
  return { release: () => released.resolve() }
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

async function createInWorkspace(stack: Stack, api: ClaxedoApi, titles: readonly string[]) {
  const workspace: Workspace = await stack.daemon.makeWorkspace("races")
  const create = (title: string) => api.createSession(workspace.directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const sessions = [await create(titles[0])]
  for (let start = 1; start < titles.length; start += 50) {
    sessions.push(...(await Promise.all(titles.slice(start, start + 50).map(create))))
  }
  return { directory: workspace.directory, sessions: sessions.map(({ id, title }) => ({ id, title, directory: workspace.directory })) }
}

export async function setup(stack: Stack, api: ClaxedoApi, app: Page, titles: readonly string[], options: SetupOptions = {}) {
  const share = Math.ceil(titles.length / (options.workspaces ?? 1))
  const chunks = Array.from({ length: Math.ceil(titles.length / share) }, (_, index) => titles.slice(index * share, (index + 1) * share))
  const created: Awaited<ReturnType<typeof createInWorkspace>>[] = []
  for (const chunk of chunks) created.push(await createInWorkspace(stack, api, chunk))
  if (options.open ?? true) await app.goto(`${stack.url}/`)
  const sessions = created.flatMap((workspace) => workspace.sessions)
  const directories = created.map((workspace) => workspace.directory)
  const checked: Checked = {
    stack,
    api,
    directory: directories[0],
    directories,
    known: new Set(sessions.map((session) => session.id)),
    directoryOf: new Map(sessions.map((session) => [session.id, session.directory])),
  }
  return { sessions, checked }
}
