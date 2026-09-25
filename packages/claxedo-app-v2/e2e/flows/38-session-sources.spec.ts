import type { Page } from "@playwright/test"
import { apiRequests, expect, SCRIPTED_ACP_HARNESS, test, UI, type ClaxedoApi, type Stack } from "../harness"

type ListItem = { readonly sessionId: string; readonly title: string; readonly archivedAt?: number | null }

const PAGE = 5

async function projectOrder(stack: Stack, projectId: string): Promise<string[]> {
  const url = new URL("/api/claxedo/session-list", stack.url)
  for (const [key, value] of Object.entries({ scope: "project", projectId, sort: "human_turn_desc", limit: "100" })) url.searchParams.set(key, value)
  const response = await fetch(url)
  expect(response.status).toBe(200)
  return ((await response.json()) as { items: ListItem[] }).items.filter((item) => !item.archivedAt).map((item) => item.title)
}

async function worktreeOf(stack: Stack, workspaceId: string): Promise<string> {
  const url = new URL("/experimental/worktree", stack.url)
  url.searchParams.set("workspaceId", workspaceId)
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  expect(response.ok, `the worktree create answered ${response.status}`).toBe(true)
  return ((await response.json()) as { directory: string }).directory
}

function projectRows(app: Page, projectId: string) {
  return app.locator(`[data-testid="project-group"][data-project-id="${projectId}"]`).getByTestId("rail-sidebar-session-row")
}

async function projectTitles(app: Page, projectId: string): Promise<string[]> {
  return projectRows(app, projectId)
    .locator('[data-slot="navigation-row-activate"]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""))
}

async function createAll(api: ClaxedoApi, directory: string, titles: readonly string[]) {
  for (const title of titles) await api.createSession(directory, { title, harness: SCRIPTED_ACP_HARNESS })
}

test.skip(({ isMobile }) => isMobile, "flow 38 runs at desktop width; flow 33 owns the phone rail")

test("38 a project's rail is one order across its folder and its worktree, a true prefix at every Show more", async ({ stack, api, app }) => {
  test.skip(stack.app !== "v2", "v1 cuts each placement at its own tail")
  const workspace = await stack.daemon.makeWorkspace("sources", "Sources")
  const worktree = await worktreeOf(stack, workspace.id)
  await createAll(api, worktree, ["Worktree 1", "Worktree 2", "Worktree 3"])
  await createAll(api, workspace.directory, Array.from({ length: 12 }, (_, index) => `Folder ${index + 1}`))
  const order = await projectOrder(stack, workspace.projectId)
  expect(order).toHaveLength(15)

  await app.goto(`${stack.url}/`)
  const more = app.locator(`[data-testid="project-group"][data-project-id="${workspace.projectId}"]`).getByTestId("rail-sidebar-session-load-more")
  for (let shown = PAGE; shown < order.length + PAGE; shown += PAGE) {
    await expect.poll(() => projectTitles(app, workspace.projectId), { message: `the first ${shown} rows are the project's order` })
      .toEqual(order.slice(0, shown))
    if (shown >= order.length) break
    await more.click()
  }
  await expect(more).toHaveCount(0)
})

test("38 a boot reads one page per project and no status, permission, question or wake", async ({ stack, api, app }) => {
  test.skip(stack.app !== "v2", "v1 reads each placement's page and statuses")
  const projects = [await stack.daemon.makeWorkspace("boot-a", "Boot A"), await stack.daemon.makeWorkspace("boot-b", "Boot B")]
  for (const project of projects) await createAll(api, project.directory, [`${project.projectId} one`, `${project.projectId} two`])
  await app.goto("about:blank")
  const settled = apiRequests(app, stack.url)
  await app.goto(`${stack.url}/`)
  for (const project of projects) await expect(projectRows(app, project.projectId)).toHaveCount(2)
  const boot = await settled()

  const catalog = new Set((await (await fetch(new URL("/api/claxedo/bootstrap", stack.url))).json() as { project?: Array<{ id: string }> }).project?.map((project) => project.id))
  expect(boot.filter((path) => path === "/api/claxedo/session-list"), "one list read per project").toHaveLength(catalog.size)
  expect(boot.filter((path) => /\/session\/status$|\/permission$|\/question$|\/session-activity$/.test(path)), "status reads at boot").toEqual([])
  expect(boot.filter((path) => /\/connection|\/start$|\/wake/.test(path)), "wakes at boot").toEqual([])
})

test("38 a project whose page cannot be read leaves every other project's rows, and a retry loads it", async ({ stack, api, app }) => {
  test.skip(stack.app !== "v2", "v1 blanks the rail on one failed read")
  const healthy = await stack.daemon.makeWorkspace("healthy", "Healthy")
  const broken = await stack.daemon.makeWorkspace("broken", "Broken")
  await createAll(api, healthy.directory, ["Healthy one"])
  await createAll(api, broken.directory, ["Broken one"])
  let failing = true
  await app.route(new RegExp(`/api/claxedo/session-list\\?.*projectId=${broken.projectId}`), (route) =>
    failing ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"message":"unavailable"}}' }) : route.continue())
  await app.goto(`${stack.url}/`)

  const rail = app.getByRole("navigation", { name: UI.rail })
  await expect(rail.getByRole("button", { name: "Healthy one", exact: true })).toBeVisible()
  const brokenGroup = app.locator(`[data-testid="project-group"][data-project-id="${broken.projectId}"]`)
  const expand = brokenGroup.getByRole("button", { name: "Expand project" })
  if (await expand.count()) await expand.click()
  await expect(brokenGroup.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(projectRows(app, broken.projectId)).toHaveCount(0)

  failing = false
  await brokenGroup.getByRole("button", { name: "Retry" }).click()
  await expect(rail.getByRole("button", { name: "Broken one", exact: true })).toBeVisible()
  await expect(rail.getByRole("button", { name: "Healthy one", exact: true })).toBeVisible()
})
