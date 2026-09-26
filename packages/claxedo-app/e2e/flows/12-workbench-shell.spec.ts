import type { Page } from "@playwright/test"
import { acpScriptToken, apiRequests, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type AcpStep, type ClaxedoApi, type Stack } from "../harness"
import { recordSwitchFrames, switchReport } from "./12-switch-paint.frames"

function panes(app: Page) {
  return app.getByRole("navigation", { name: "Workbench panes" })
}

function divider(app: Page) {
  return app.getByRole("separator", { name: "Resize panes" })
}

async function dragRowToRightEdge(app: Page, title: string) {
  const row = await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: title, exact: true }).boundingBox()
  const bench = await app.getByRole("main").boundingBox()
  if (!row || !bench) throw new Error("The rail row or the workbench has no box")
  await app.mouse.move(row.x + row.width / 2, row.y + row.height / 2)
  await app.mouse.down()
  await app.mouse.move(row.x + row.width / 2 + 30, row.y + row.height / 2 + 20, { steps: 4 })
  await app.mouse.move(bench.x + bench.width - 12, bench.y + bench.height / 2, { steps: 12 })
  await app.mouse.up()
}

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")

test("12 workbench and shell: a rail row dragged to the edge splits, compact tabs, close a pane and a tab, the palette", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Second", exact: true }).click()
  await expect(divider(app)).toHaveCount(0)
  await dragRowToRightEdge(app, "First")
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toBeVisible()
  await expect(panes(app).getByRole("button", { name: "Second", exact: true })).toBeVisible()

  await app.getByRole("button", { name: "Close Pane" }).first().click()
  await expect(divider(app)).toHaveCount(0)

  await panes(app).getByRole("button", { name: "Close First" }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toHaveCount(0)
  await expect(panes(app).getByRole("button", { name: "Second", exact: true })).toBeVisible()
  expect((await api.session(workspace.directory, first.id)).title).toBe("First")

  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: UI.palette })).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(app.getByRole("dialog", { name: UI.palette })).toHaveCount(0)
})

async function domWritesDuring(app: Page, act: () => Promise<void>): Promise<string[]> {
  await app.evaluate(() => {
    const writes: string[] = []
    Object.assign(window, { resizeWrites: writes })
    new MutationObserver((records) => {
      for (const record of records) writes.push(`${record.type} ${(record.target as Element).tagName ?? record.target.nodeName} ${record.attributeName ?? ""}`)
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  await act()
  await app.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return app.evaluate(() => (window as unknown as { resizeWrites: string[] }).resizeWrites)
}

test("12 a narrow workbench shows one split pane without chrome, and a resize of an unsplit one writes nothing", async ({ stack, api, app }) => {
  await app.setViewportSize({ width: 1280, height: 800 })
  const workspace = await stack.daemon.makeWorkspace("narrow", "Narrow")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Second", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Second", exact: true }).click()
  await dragRowToRightEdge(app, "First")
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.setViewportSize({ width: 900, height: 800 })
  await expect(divider(app)).toBeHidden()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(0)
  await app.setViewportSize({ width: 1280, height: 800 })
  await expect(divider(app)).toBeVisible()
  await expect(app.getByRole("button", { name: "Close Pane" })).toHaveCount(2)

  await app.getByRole("button", { name: "Close Pane" }).first().click()
  await expect(divider(app)).toHaveCount(0)
  const writes = await domWritesDuring(app, async () => {
    await app.setViewportSize({ width: 900, height: 800 })
    await app.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await app.setViewportSize({ width: 1280, height: 800 })
  })
  expect(writes).toEqual([])
  expect((await api.session(workspace.directory, first.id)).title).toBe("First")
})

test("12 New Session again focuses the workspace's one draft tab", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const draftTab = () => panes(app).getByRole("button", { name: /^New [Ss]ession$/ })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  const newSession = () => app.getByRole("main").getByRole("button", { name: UI.newSession, exact: true }).last()
  await newSession().click()
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "First", exact: true }).click()
  await newSession().click()
  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(panes(app).getByRole("button", { name: "First", exact: true })).toBeVisible()
  await expect(draftTab()).toHaveCount(1)
})

test("12 closing every tab leaves the workspace's new-session composer, and New Session keeps it", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const composer = app.getByRole("textbox", { name: UI.composer })

  const newSession = () => app.getByRole("main").getByRole("button", { name: UI.newSession, exact: true }).last()

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await expect(composer).toBeVisible()
  await newSession().click()
  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await panes(app).getByRole("button", { name: "Close First" }).click()
  await panes(app).getByRole("button", { name: /^Close New Session$/i }).click()

  await expect(composer).toBeVisible()
  await newSession().click()
  await expect(composer).toBeVisible()
  await expect(app).toHaveURL(new RegExp(`/w/${workspace.id}(/session)?$`))
})

test("12 Tasks and Marketplace share one page tab that shows the last one opened", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("bench", "Bench")
  const first = await api.createSession(workspace.directory, { title: "First", harness: SCRIPTED_ACP_HARNESS })
  const pageTabs = () => panes(app).getByRole("button", { name: /^(Tasks|Marketplace)$/ })

  await app.goto(`${stack.url}${sessionRoute(workspace.id, first.id)}`)
  await app.getByTestId("sidebar-tasks-entry").click()
  await expect(app).toHaveURL(/\/tasks$/)
  await app.getByTestId("sidebar-marketplace-entry").click()
  await expect(app).toHaveURL(/\/marketplace$/)
  await app.getByTestId("sidebar-tasks-entry").click()
  await app.getByRole("button", { name: UI.hideSidebar }).click()
  await expect(pageTabs()).toHaveCount(1)
  await expect(pageTabs()).toHaveAccessibleName("Tasks")

  await panes(app).getByRole("button", { name: "First", exact: true }).click()
  await expect(app).toHaveURL(new RegExp(`/${first.id}$`))
  await pageTabs().click()
  await expect(app).toHaveURL(/\/tasks$/)
})

test("12 a boot reads neither Tasks nor pi's provider catalog, an open reads each thing once, and a revisit reads nothing", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("reads", "Reads")
  await api.createSession(workspace.directory, { title: "Alpha", harness: SCRIPTED_ACP_HARNESS })
  await api.createSession(workspace.directory, { title: "Beta", harness: SCRIPTED_ACP_HARNESS })
  await app.goto("about:blank")
  const settled = apiRequests(app, stack.url)
  const rail = app.getByRole("navigation", { name: UI.rail })
  await app.goto(`${stack.url}/`)
  await expect(rail.getByRole("button", { name: "Beta", exact: true })).toBeVisible()
  const boot = await settled()
  expect(boot.filter((path) => path.startsWith("/api/claxedo/tasks/") || path === "/api/claxedo/agent-config/providers")).toEqual([])
  const open = async (title: string) => {
    await rail.getByRole("button", { name: title, exact: true }).click()
    await expect(app.getByRole("heading", { name: title, level: 1 })).toBeVisible()
    await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
    return settled()
  }
  for (const title of ["Alpha", "Beta"]) {
    const reads = await open(title)
    expect(reads.filter((path, index) => reads.indexOf(path) !== index), `${title} read twice`).toEqual([])
  }
  expect(await open("Alpha"), "revisiting Alpha").toEqual([])
  expect(await open("Beta"), "revisiting Beta").toEqual([])
  expect((await api.sessions(workspace.directory)).map((session) => session.title).sort()).toEqual(["Alpha", "Beta"])
})

test("12 opening a menu hides the page without touching each icon in the sprite", async ({ stack, api, app }) => {
  const workspace = await stack.daemon.makeWorkspace("sprite", "Sprite")
  const session = await api.createSession(workspace.directory, { title: "Sprite", harness: SCRIPTED_ACP_HARNESS })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect.poll(() => app.evaluate(() => document.querySelectorAll("svg symbol").length)).toBeGreaterThan(20)
  await app.evaluate(() => {
    const writes: string[] = []
    new MutationObserver((records) => {
      for (const record of records) writes.push(record.target instanceof Element ? record.target.tagName.toLowerCase() : "?")
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-hidden"] })
    Reflect.set(window, "__claxedoAriaHiddenWrites", writes)
  })
  const menu = app.getByRole("menu")
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await expect(menu).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  const writes = await app.evaluate(() => Reflect.get(window, "__claxedoAriaHiddenWrites") as string[])
  expect(writes.filter((tag) => tag === "symbol"), "aria-hidden writes on sprite symbols").toEqual([])
  expect(writes.length).toBeLessThanOrEqual(20)
})

async function seedTurns(stack: Stack, api: ClaxedoApi, directory: string, title: string, turns: number, shape: { readonly lines?: number; readonly lastFails?: boolean } = {}) {
  const session = await api.createSession(directory, { title, harness: SCRIPTED_ACP_HARNESS })
  const reply = Array.from({ length: 6 }, (_, line) => `${title} reply line ${line + 1}.`).join("\n\n")
  const steps: AcpStep[] = [{ kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${directory}/README.md` }], text: "readme\n" }, { kind: "text", text: reply }]
  await stack.acp.write(`paint-${title}`, { steps })
  await stack.acp.write(`paint-${title}-last`, { steps: shape.lastFails ? [...steps, { kind: "error", message: `${title} failed` }] : steps })
  const body = (turn: number) => Array.from({ length: shape.lines ?? 1 }, (_, line) => `${title} turn ${turn} line ${line + 1}: review the fixture and implement the next improvement.`).join("\n")
  for (let turn = 1; turn <= turns; turn += 1) {
    const script = turn === turns ? `paint-${title}-last` : `paint-${title}`
    await api.prompt(directory, session.id, `${body(turn)} ${acpScriptToken(script)}`).catch((error: unknown) => {
      if (!shape.lastFails || turn !== turns) throw error
    })
  }
  return session
}

test("12 a session switch shows the previous session until the next one is laid out in its final place, and nothing between", async ({ stack, api, app }, info) => {
  const here = await stack.daemon.makeWorkspace("paint", "Paint")
  const there = await stack.daemon.makeWorkspace("elsewhere", "Elsewhere")
  const previous = await seedTurns(stack, api, here.directory, "Previous", 2)
  const target = await seedTurns(stack, api, here.directory, "Target", 12)
  const elsewhere = await seedTurns(stack, api, there.directory, "Elsewhere", 12)
  const long = await seedTurns(stack, api, here.directory, "Long", 30, { lines: 40 })
  const failed = await seedTurns(stack, api, here.directory, "Failed", 12, { lastFails: true })
  const short = await seedTurns(stack, api, here.directory, "Short", 1)
  const pi = await api.createSession(here.directory, { title: "Pi", harness: { id: "pi", access: "native" } })
  await api.prompt(here.directory, pi.id, "Pi turn: review the fixture.")
  await app.goto(`${stack.url}${sessionRoute(here.id, previous.id)}`)
  await expect(app.getByText("Previous reply line 6.").first()).toBeVisible()
  const settled = apiRequests(app, stack.url)
  await settled()

  const acp = { model: "Scripted ACP default", nameKnown: true }
  const switches = [
    { label: "unvisited", next: target, ...acp },
    { label: "unvisited short", next: short, ...acp },
    { label: "unvisited Pi", next: pi, model: "anthropic/claude-opus-4-8", nameKnown: false },
    { label: "another workspace", next: elsewhere, ...acp },
    { label: "long rows", next: long, ...acp },
    { label: "failed last turn", next: failed, ...acp },
    { label: "visited", next: previous, ...acp },
  ]
  for (const { label, next, model, nameKnown } of switches) {
    await test.step(`switch to the ${label} session`, async () => {
      const frames = await recordSwitchFrames(app, { targetId: next.id, quietFrames: 30 })
      await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: next.title, exact: true }).click()
      const seen = switchReport(await frames(), next.id)
      const reads = await settled()
      await info.attach(`${label} switch`, { body: [...seen.states, "", `settled +${seen.settledAt}ms`, ...reads].join("\n"), contentType: "text/plain" })
      expect.soft(seen.empty, "frames with an empty, loading or missing session body").toEqual([])
      expect.soft(seen.overlaid, "frames painting two sessions at once").toEqual([])
      expect.soft(seen.jumps, `frames where the ${label} session's rows or scroll moved after it first showed`).toEqual([])
      if (nameKnown) expect.soft(seen.footers, `composer footer labels of the ${label} session`).toHaveLength(1)
      expect.soft(seen.footers[0], `the ${label} session's first footer names its model`).toContain(model)
      expect.soft(seen.footers[0], `the ${label} session's first footer`).not.toMatch(/Select (model|agent)/)
      expect.soft(seen.railApart, "frames where the rail selects a session other than the one shown").toEqual([])
      expect.soft(seen.sessions, "sessions shown, in order").toEqual(seen.sessions.length === 1 ? [next.id] : [seen.sessions[0], next.id])
    })
  }
})
