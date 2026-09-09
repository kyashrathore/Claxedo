/**
 * `appExtensions()` (`src/features/extensions/data/app.tsx`) sets `strings:
 * cloudStrings` (`src/platform/i18n/cloud-strings.ts`), which overrides both
 * `workspace.new` and `command.project.open` to the literal "New Project" — so
 * the rail's "+ New project" button and `DialogSelectDirectory`'s title both
 * render that, not the "New workspace"/"Open project" the base `en` dictionary
 * defines. Every selector in this file pins the rendered cloud-branded string.
 */
import { sessionListRoute } from "../helpers/contracts/session-list"
import { isOrgListPath, orgListResponse } from "../helpers/contracts/org-list"
import { expect, test, type Page } from "@playwright/test"

const DIR = "/tmp/e2e-core-lifecycle-main"
const PROJECT_ID = "proj_core_lifecycle"
const PROJECT_NAME = "core-lifecycle-main"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function api(request: { resourceType: () => string }) {
  const type = request.resourceType()
  return type === "fetch" || type === "xhr"
}

function json(route: import("@playwright/test").Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

type SeedProject = {
  id?: string
  worktree?: string
  name?: string
  sandboxes?: string[]
  workspaces?: Record<string, {
    id?: string
    workspaceId?: string
    directory?: string
    workspace_name?: string | null
    kind?: "local" | "cloud" | "user-hosted"
    available?: boolean
  }>
}

async function seedProject(page: Page, dir: string = DIR) {
  await page.addInitScript((d: string) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    if (localStorage.getItem("claxedo.global.dat:server")) return
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

/**
 * Minimal standalone runtime mock for this spec's surface: bootstrap, project, session
 * list, provider, config and event-stream plumbing in the same shapes `installMockRuntime`
 * uses, duplicated here because this spec's project record needs custom
 * `sandboxes`/`workspaces` fields the shared fixture exposes no knob for. No turn is ever
 * sent, so the shared turn-streaming machinery is not installed.
 */
async function installLifecycleMock(page: Page, project: SeedProject = {}) {
  const proj = {
    id: project.id ?? PROJECT_ID,
    worktree: project.worktree ?? DIR,
    name: project.name ?? PROJECT_NAME,
    sandboxes: project.sandboxes ?? [],
    workspaces: project.workspaces ?? {},
    time: { created: Date.now(), updated: Date.now() },
  }

  const bootstrapBody = {
    healthy: true,
    version: "1.0.0-test",
    path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
    project: [proj],
    provider: {
      all: [{ id: "opencode", name: "opencode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
      default: { opencode: "big-pickle" },
      connected: ["opencode"],
    },
    provider_auth: { opencode: [{ type: "api", label: "API key" }] },
    config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
  }

  await page.route("**/api/claxedo/bootstrap**", (r) => (api(r.request()) ? json(r, bootstrapBody) : r.continue()))

  const handleProjectList = (r: import("@playwright/test").Route) => {
    if (!api(r.request())) return r.continue()
    if (r.request().method() !== "GET") return r.fallback()
    return json(r, [proj])
  }
  await page.route("**/project", handleProjectList)
  await page.route("**/project?**", handleProjectList)
  // A PATCH to `/project/:id` fires unprompted on every load, unrelated to the Edit dialog,
  // so the fallback belongs here rather than only in the rename test. The rename test
  // registers its own narrower `**/project/${PROJECT_ID}**` route afterwards, and
  // Playwright runs the last-registered route first, so that one still wins there.
  await page.route("**/project/*", (r) => {
    if (!api(r.request())) return r.continue()
    if (r.request().method() !== "PATCH") return r.fallback()
    return json(r, proj)
  })
  // `/project/current` is a different endpoint from the list above (SDK
  // `Project.current()`), fired unprompted on load by whatever reads the active project.
  //
  // The trailing `**` throughout this file is load-bearing: Playwright glob routes are
  // fully anchored, so a pattern ending at the bare path segment does not match a URL with
  // a `?query` — and `/provider`, `/config` and `/project/:id` are all called with query
  // params in this build. A miss does not fail loudly: `getClaxedoServerUrl()`
  // (`src/utils/api.ts`) falls back to `http://127.0.0.1:3001`, where nothing listens, so
  // an unintercepted request leaks onto real network I/O and dies quietly.
  await page.route("**/project/current**", (r) => (api(r.request()) ? json(r, proj) : r.continue()))
  await page.route("**/experimental/project", handleProjectList)
  await page.route("**/experimental/project?**", handleProjectList)

  // The real local server's health document reports `localExecution: true`
  // (`local-app.ts`), which is what lets the folder picker browse this
  // machine (`useDirectorySearch`'s gate).
  await page.route("**/health**", (r) => (api(r.request()) ? json(r, { healthy: true, localExecution: true }) : r.continue()))
  // `DialogSelectDirectory`'s search box fires an empty-query lookup against `/find/file`
  // the instant it opens, before any typing. That is a different endpoint from `/file`,
  // which only `useDirectorySearch`'s "contains a path segment" branch hits and which is
  // mocked per-test where needed.
  await page.route("**/find/file**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
  await page.route("**/path**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/path") return r.fallback()
    return json(r, { worktree: DIR })
  })
  await page.route("**/agent**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/agent") return r.fallback()
    return json(r, [{ id: "build", name: "build", description: "Build agent" }])
  })
  await page.route("**/provider**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/provider") return r.fallback()
    return json(r, bootstrapBody.provider)
  })
  await page.route("**/provider/auth**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/provider/auth") return r.fallback()
    return json(r, bootstrapBody.provider_auth)
  })
  await page.route("**/config**", (r) => {
    if (!api(r.request())) return r.continue()
    if (new URL(r.request().url()).pathname !== "/config") return r.fallback()
    return json(r, bootstrapBody.config)
  })
  await page.route("**/mcp**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/mcp" ? json(r, {}) : r.continue()))
  await page.route("**/vcs**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/vcs" ? json(r, {}) : r.continue()))
  await page.route("**/command**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/command" ? json(r, []) : r.continue()))
  await page.route("**/permission**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/permission" ? json(r, []) : r.continue()))
  await page.route("**/question**", (r) => (api(r.request()) && new URL(r.request().url()).pathname === "/question" ? json(r, []) : r.continue()))
  // Workspace resolve, both spellings. `workspaceResolveUrl`
  // (`src/platform/runtime/agent/workspace-control-routes.ts`) rewrites the path to
  // `/api/claxedo/workspace/resolve` whenever the server base URL is a loopback transport,
  // which the default control-plane origin always is here. Without the claxedo twin every
  // resolve escapes onto the dead network, so a cloud-backed workspace never reaches
  // "ready", never mints a connection, and the role-gated "Delete workspace" kebab item
  // behind `canMutateWorkspace` never renders at all.
  //
  // The response mirrors the server's own projection (`workspaceResponse`,
  // packages/claxedo-server-core/src/workspace/store/response.ts) and is derived from this
  // fixture's seeded `workspaces` map, so a project seeded with a cloud main workspace
  // resolves as cloud.
  const resolveHandler = (r: import("@playwright/test").Route) => {
    if (!api(r.request())) return r.continue()
    const url = new URL(r.request().url())
    const wantedId = url.searchParams.get("workspaceId") ?? undefined
    const wantedDir = url.searchParams.get("directory") ?? undefined
    const hit = Object.entries(proj.workspaces).find(([key, ws]) =>
      (wantedId && (ws.workspaceId === wantedId || ws.id === wantedId || key === wantedId)) ||
      (wantedDir && ((ws.directory ?? key) === wantedDir)),
    )
    const record = hit?.[1]
    const directory = record?.directory ?? hit?.[0] ?? wantedDir ?? DIR
    const kind = record?.kind ?? "local"
    const backing = kind === "cloud" ? { kind: "cloud-vm" } : kind === "user-hosted" ? { kind: "user-hosted" } : { kind: "local-worktree" }
    return json(r, {
      workspaceId: record?.workspaceId ?? record?.id ?? `local-${proj.id}`,
      projectId: proj.id,
      directory,
      workspaceName: record?.workspace_name ?? null,
      access: kind === "cloud" ? "cloud" : kind === "user-hosted" ? "user-hosted" : "local",
      backing,
      kind,
      driver: null,
      status: "ready",
      git: { repo: null, branch: null, remote: null },
    })
  }
  await page.route("**/api/workspace/resolve**", resolveHandler)
  await page.route("**/api/claxedo/workspace/resolve**", resolveHandler)
  await page.route("**/api/claxedo/agent-config/**", (r) => (api(r.request()) ? json(r, { source: "runner", stale: false, options: [] }) : r.continue()))

  const eventStreamHandler = async (route: import("@playwright/test").Route) => {
    if (!api(route.request())) return route.continue()
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
  }
  // One stream, three spellings. Both real servers mount a single handler on
  // `/global/event`, `/api/wr/events` and `/api/claxedo/events`, so every spelling the app
  // might connect on has to answer here or the central stream falls through to the
  // unreachable real origin.
  await page.route("**/global/event?**", eventStreamHandler)
  await page.route("**/event?**", eventStreamHandler)
  await page.route("**/api/wr/events**", eventStreamHandler)
  await page.route("**/api/claxedo/events**", eventStreamHandler)
  // The rail's org/team switcher mounts alongside the header actions this spec drives, and
  // its read otherwise leaks onto the unreachable backend. `[]` is the authority's own
  // answer for a principal in no organization.
  await page.route("**/api/control/orgs**", (r) => {
    if (!api(r.request())) return r.continue()
    if (!isOrgListPath(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, orgListResponse())
  })
  // Review/diff panel calls — benign-empty so the panel shows "no changes"
  // instead of leaking onto the real (unreachable) backend.
  await page.route("**/api/wr/diff/**", (r) => {
    if (!api(r.request())) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    const body = pathname.endsWith("/refs") ? { branches: [], tags: [], recent: [] } : pathname.endsWith("/targets") ? {} : []
    return json(r, body)
  })

  const handleSessionList = (r: import("@playwright/test").Route) => (api(r.request()) ? json(r, []) : r.continue())
  await page.route("**/session", handleSessionList)
  await page.route("**/session?**", handleSessionList)
  await page.route("**/experimental/session", handleSessionList)
  await page.route("**/experimental/session?**", handleSessionList)
  await page.route("**/session/*/message**", (r) =>
    api(r.request()) ? json(r, { messages: [], maxEventOrdinal: 0 }) : r.continue(),
  )
  await page.route("**/session/*/capabilities**", (r) => (api(r.request()) ? json(r, { transport: "runtime" }) : r.continue()))
  await page.route("**/session/status**", (r) => (api(r.request()) ? json(r, {}) : r.continue()))

  // The sidebar is docked by default (`sidebarPinned()` in `src/shell/app-shell-layout.tsx`),
  // so every project and workspace row mounts immediately and queries two distinct
  // endpoints: `sessionListQueryOptions` always hits `/api/control/session-list`, signed or
  // not, and something else separately hits the plural `/api/control/sessions`.
  await page.route(sessionListRoute, (r) =>
    api(r.request())
      ? json(r, { view: { scope: "workspace", groupBy: "none", sort: "updated_desc", limit: 50 }, items: [], totalKnown: 0 })
      : r.continue(),
  )
  await page.route("**/api/control/sessions**", (r) => (api(r.request()) ? json(r, []) : r.continue()))

  return { project: proj }
}

async function openApp(page: Page, dir: string = DIR) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
}

/** Switches the sidebar's "Group by" view option to "Workspace", the only mode in which
 * non-main workspace rows (`[data-testid="workspace-header"]`) render at all.
 *
 * In that mode each project is a collapsible `[data-testid="workspace-project-header"]`
 * folder (`WorkspaceGroupBlock`) that auto-opens only when the project is the active one or
 * one of its workspace sections already has session rows. Neither holds for this fixture,
 * so the folder renders collapsed with no `workspace-header` children until its "Expand
 * project" disclosure is clicked.
 */
async function groupByWorkspace(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "View options" }).hover()
  await page.getByRole("menuitemradio", { name: "Workspace" }).click()
  // The radio item has `closeOnSelect={false}`, so the menu stays open by design and has to
  // be dismissed explicitly — with a poll, not a fire-and-forget double-Escape. Kobalte's
  // selectable-collection keydown handler consumes Escapes landing in the window just after
  // the click, and the dismissable layer skips any already-`defaultPrevented` Escape, so
  // both menus survive. While they do, `hide-outside` leaves the whole app `aria-hidden`
  // and every later `getByRole()` resolves nothing even though bare CSS locators still
  // match.
  await expect
    .poll(async () => {
      await page.keyboard.press("Escape")
      return page.getByRole("menu").count()
    }, { timeout: 10_000 })
    .toBe(0)
  // `[data-testid="workspace-project-header"]` always renders once grouped by workspace;
  // only its `workspace-header` children are conditional on the folder being open.
  await expect(page.locator('[data-testid="workspace-project-header"]').first()).toBeVisible({ timeout: 10_000 })
  // The disclosure caret is a `<span role="button" aria-label="Expand project">` that
  // `getByRole("button", { name: "Expand project" })` never matches — the accessible name
  // computed from this span's icon children is not its `aria-label`. A `[role="button"]`
  // CSS locator scoped to the header finds it.
  const expandToggle = page.locator('[data-testid="workspace-project-header"] [role="button"]').first()
  if ((await expandToggle.getAttribute("aria-label")) === "Expand project") await expandToggle.click()
}

function toastTitle(page: Page) {
  return page.locator('[data-slot="toast-title"]')
}

test.describe("core workspace lifecycle @core", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (message) => {
      if (message.type() === "error") {
        // eslint-disable-next-line no-console
        console.log(`[browser console error] ${message.text()}`)
      }
    })
  })

  test("selecting an invalid resolved path shows a toast and creates nothing", async ({ page }) => {
    await seedProject(page)
    await installLifecycleMock(page)

    await page.route("**/file?**", (r) => {
      if (!api(r.request())) return r.continue()
      if (new URL(r.request().url()).pathname !== "/file") return r.fallback()
      return json(r, [{ name: "workspace", absolute: "/workspace", type: "directory" }])
    })

    // The server accepts the folder — this mock stands in for one whose filesystem has it.
    // What is under test is the app's refusal of a checkout it can never open as a local
    // worktree.
    const createBodies: unknown[] = []
    await page.route("**/api/claxedo/projects**", (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "POST") return r.fallback()
      createBodies.push(r.request().postDataJSON?.() ?? undefined)
      return json(r, {
        project: {
          id: "prj_blocked_workspace",
          name: "workspace",
          env: {},
          directory: "/workspace",
          repoUrl: null,
          created_at: 1,
          updated_at: 1,
        },
      }, 201)
    })

    let createSessionCount = 0
    await page.route("**/session", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() === "POST") createSessionCount += 1
      return json(r, [])
    })

    await openApp(page)

    // "New Project" is an intent, not a dialog: the rail button raises
    // `layout.projects.requestCreate()` and the draft composer's Project chip answers by
    // opening its "Create project…" panel.
    await page.getByRole("button", { name: "New Project", exact: true }).click()
    const form = page.locator('[data-slot="project-create-form"]')
    await expect(form).toBeVisible({ timeout: 10_000 })

    // The folder source opens `DialogSelectDirectory`, titled by `command.project.open`,
    // which the cloud string override renders as "New Project".
    await form.getByRole("button", { name: "Select project" }).click()
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("New Project")

    // Not `[data-slot="list-search-input"]`: `TextField` overrides any caller-supplied
    // `data-slot` with a hardcoded `"input-input"` on the real `<input>`.
    const search = page.locator('[data-slot="list-search-container"] input')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill("/workspace")

    const row = page.locator('[data-slot="list-item"]').filter({ hasText: "workspace" })
    await expect(row.first()).toBeVisible({ timeout: 10_000 })
    await row.first().click()

    await expect(form.locator('[data-slot="project-create-folder"]')).toHaveText("/workspace")
    expect(createBodies).toEqual([])

    await form.getByRole("button", { name: "Create project" }).click()
    await expect.poll(() => createBodies.length, { timeout: 10_000 }).toBe(1)
    expect(createBodies[0]).toEqual({ name: "workspace", source: { kind: "directory", directory: "/workspace" } })

    await expect(toastTitle(page)).toHaveText("Invalid project path", { timeout: 10_000 })
    await expect(page.getByText("/workspace", { exact: true }).last()).toBeVisible()

    // The composer refuses the checkout where the create lands and keeps its panel open so
    // the user can pick again; nothing is created by the bad selection.
    await expect(form).toBeVisible()
    expect(createSessionCount).toBe(0)
  })


  test("kebab Edit renames a project", async ({ page }) => {
    await installLifecycleMock(page)
    await seedProject(page)
    await openApp(page)

    let patchBody: unknown
    // The trailing `**` is required: `Project.update()` sends `directory` as a query param,
    // and a glob ending at the bare projectID would not match a URL carrying one.
    await page.route(`**/project/${PROJECT_ID}**`, async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "PATCH") return r.fallback()
      patchBody = r.request().postDataJSON()
      return json(r, { id: PROJECT_ID, worktree: DIR, name: "renamed-lifecycle-project" })
    })

    // The kebab's aria-label is the workspace label — "main", since this worktree has no
    // `workspace_name` override — not the project name shown in the row text. And the
    // header's action cluster, kebab included, is not in the DOM until the header is
    // hovered or focused (`rail-hover-engagement.ts`), so engage it first.
    await page.locator('[data-testid="project-header"]').hover()
    await page.getByRole("button", { name: "More options for main" }).click()
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Edit project")
    const nameField = page.getByLabel("Name", { exact: true })
    await expect(nameField).toBeVisible({ timeout: 10_000 })
    await nameField.fill("renamed-lifecycle-project")
    await page.screenshot({ path: "test-results/evidence/core-workspace-lifecycle/edit-project-dialog.png" })
    await page.getByRole("button", { name: "Save", exact: true }).click()

    await expect.poll(() => patchBody, { timeout: 10_000 }).toMatchObject({ name: "renamed-lifecycle-project" })
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 10_000 })
  })

  test("kebab Delete workspace on a non-main worktree: dirty check, cancel, disabled states, confirm", async ({ page }) => {
    const SECOND_DIR = "/tmp/e2e-core-lifecycle-second"
    const lifecycle = await installLifecycleMock(page, {
      sandboxes: [SECOND_DIR],
      workspaces: { [SECOND_DIR]: { kind: "local", available: true, directory: SECOND_DIR } },
    })
    await seedProject(page)

    let statusResolve: (() => void) | undefined
    const statusGate = new Promise<void>((resolve) => (statusResolve = resolve))
    let statusCalls = 0
    await page.route("**/file/status**", async (r) => {
      if (!api(r.request())) return r.continue()
      statusCalls += 1
      await statusGate
      return json(r, [{ path: "src/index.ts", status: "modified" }])
    })

    let removeBody: unknown
    let removeResolve: (() => void) | undefined
    const removeGate = new Promise<void>((resolve) => (removeResolve = resolve))
    await page.route("**/experimental/worktree**", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "DELETE") return r.fallback()
      removeBody = r.request().postDataJSON()
      await removeGate
      // The real DELETE commits the project row through `project.removeSandbox` before
      // returning 200, so every later `/project` read agrees the workspace is gone. Move
      // this fixture's own state with it, or a late catalog read resurrects the seed.
      lifecycle.project.sandboxes = lifecycle.project.sandboxes.filter((directory) => directory !== SECOND_DIR)
      delete lifecycle.project.workspaces[SECOND_DIR]
      lifecycle.project.time.updated = Date.now()
      return json(r, { ok: true })
    })

    await openApp(page)
    await groupByWorkspace(page)

    const row = page.locator('[data-testid="workspace-header"][data-workspace-id="' + SECOND_DIR + '"]')
    await expect(row).toBeVisible({ timeout: 15_000 })
    // The kebab only mounts once its owning header is hovered or focused
    // (`rail-hover-engagement.ts`).
    await row.hover()
    await row.getByRole("button", { name: /^More options for /, exact: false }).click()
    await page.getByRole("menuitem", { name: "Delete workspace", exact: true }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Delete workspace")
    const deleteButton = page.getByRole("button", { name: "Delete workspace", exact: true })
    await expect(deleteButton).toBeDisabled()
    await expect(page.getByText("Checking for unmerged changes...")).toBeVisible()

    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0)
    expect(removeBody).toBeUndefined()

    // Reopen and let the check resolve this time. (Re-hover: closing the dialog
    // leaves the pointer over where the Cancel button was, so the header is
    // disengaged and its kebab unmounted again.)
    await row.hover()
    await row.getByRole("button", { name: /^More options for /, exact: false }).click()
    await page.getByRole("menuitem", { name: "Delete workspace", exact: true }).click()
    statusResolve?.()
    await expect(page.getByText("Unmerged changes detected in this workspace.")).toBeVisible({ timeout: 10_000 })
    await expect(deleteButton).toBeEnabled()

    await deleteButton.click()
    await expect(deleteButton).toBeDisabled()
    removeResolve?.()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 10_000 })
    expect(statusCalls).toBeGreaterThanOrEqual(1)
    expect(removeBody).toMatchObject({ directory: SECOND_DIR })
    const projectList = await page.evaluate(async () => (await fetch("/project")).json()) as Array<{
      sandboxes?: string[]
      workspaces?: Record<string, unknown>
    }>
    expect(projectList[0]?.sandboxes).not.toContain(SECOND_DIR)
    expect(projectList[0]?.workspaces).not.toHaveProperty(SECOND_DIR)
    await expect(row).toHaveCount(0, { timeout: 10_000 })
  })

  test("kebab Delete workspace on a cloud MAIN workspace renders Destroy Sandbox and destroys it", async ({ page }) => {
    await installLifecycleMock(page, {
      workspaces: { [DIR]: { kind: "cloud", available: true, directory: DIR, workspaceId: "wsid_main_cloud" } },
    })
    await seedProject(page)

    let sandboxDeleteCalls = 0
    await page.route("**/api/experimental/sandbox**", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "DELETE") return r.fallback()
      sandboxDeleteCalls += 1
      return json(r, { ok: true })
    })

    // The kebab's delete item is gated behind `canMutateWorkspace()`, which for a
    // cloud-backed workspace requires `workspacePlacement()` to resolve a role. That only
    // happens once `WorkspaceGate` mints a connection via
    // `GET /api/workspace/:id/connection` and the `role` flows into
    // `applyWorkspaceConnectionInfo`. Unmocked, the mint fails silently and the menu item
    // never appears. Every other test here uses a workspace with no `workspaceId`, which
    // short-circuits the gate, so this route is mocked spec-locally rather than shared.
    await page.route("**/api/workspace/*/connection**", (r) =>
      api(r.request())
        ? json(r, {
            access: "cloud",
            backing: "cloud-vm",
            runtimeKind: "cloud",
            sessionAuthority: "managed-private",
            workspaceId: "wsid_main_cloud",
            role: "owner",
            relayUrl: "https://relay.test",
            runtimeAccessToken: "test-runtime-access-token",
            tokenExpiresAt: Date.now() + 3_600_000,
          })
        : r.continue(),
    )

    await openApp(page)

    // The kebab's aria-label is workspace-scoped ("main"), not the project's display name,
    // and it mounts only once the header is engaged.
    await page.locator('[data-testid="project-header"]').hover()
    await page.getByRole("button", { name: "More options for main" }).click()
    // The menu item's label is always "Delete workspace": `HeaderActions`'s text is
    // unconditional, and only `DialogDeleteWorkspace`'s `isCloudSandbox()` branch renders
    // "Destroy Sandbox".
    await expect(page.getByRole("menuitem", { name: "Delete workspace", exact: true })).toBeVisible({ timeout: 10_000 })
    await page.getByRole("menuitem", { name: "Delete workspace", exact: true }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Destroy Sandbox")
    await expect(page.getByText("Checking for unmerged changes...")).toHaveCount(0)
    await page.screenshot({ path: "test-results/evidence/core-workspace-lifecycle/destroy-sandbox-dialog.png" })

    await page.getByRole("button", { name: "Destroy Sandbox", exact: true }).click()

    await expect.poll(() => sandboxDeleteCalls, { timeout: 10_000 }).toBe(1)
    await expect(toastTitle(page).filter({ hasText: "Sandbox Destroyed" }))
      .toHaveText("Sandbox Destroyed", { timeout: 10_000 })
  })

  test("kebab Remove project closes the row without deleting its workspace", async ({ page }) => {
    await installLifecycleMock(page)
    await seedProject(page)

    let deleteCalls = 0
    await page.route(`**/api/workspace/${PROJECT_ID}`, async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "DELETE") return r.fallback()
      deleteCalls += 1
      return json(r, { error: "workspace store is locked" }, 500)
    })

    await openApp(page)

    const projectHeader = page.locator('[data-testid="project-header"]').filter({ hasText: PROJECT_NAME })
    await expect(projectHeader).toBeVisible({ timeout: 10_000 })

    // Engage the header so its kebab mounts.
    await projectHeader.hover()
    await page.getByRole("button", { name: "More options for main" }).click()
    await page.getByRole("menuitem", { name: "Remove project", exact: true }).click()

    // Closing is a persisted UI preference; the workspace stays on the server.
    await expect(projectHeader).toHaveCount(0, { timeout: 5_000 })

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible()
    await expect(projectHeader).toHaveCount(0)
    expect(deleteCalls).toBe(0)
  })

  test("New session on a missing local workspace opens the recovery dialog and recreates it", async ({ page }) => {
    const MISSING_DIR = "/tmp/e2e-core-lifecycle-missing"
    await installLifecycleMock(page, {
      sandboxes: [MISSING_DIR],
      workspaces: { [MISSING_DIR]: { kind: "local", available: false, directory: MISSING_DIR } },
    })
    await seedProject(page)

    let createBody: unknown
    await page.route("**/experimental/worktree**", async (r) => {
      if (!api(r.request())) return r.continue()
      if (r.request().method() !== "POST") return r.fallback()
      createBody = r.request().postDataJSON()
      return json(r, { directory: MISSING_DIR, name: "recovered" })
    })

    // `createLocalWorkspace` (workspace-recovery.tsx) waits for a `worktree.ready` event on
    // the central Claxedo event stream. The `window.__claxedoEmitTestEvent` injection point
    // is gated behind `import.meta.env.DEV`, which is false in this build, so the hook does
    // not exist on `window` to call.
    //
    // The event is delivered over the real path instead. The central stream is a
    // `GET /api/claxedo/events` SSE connection that reconnects on a steady ~2s cadence —
    // `state.failures` resets on every 200 OK, so the backoff never grows while connects
    // succeed. Flipping `deliverWorktreeReady` makes the next reconnect's body carry a real
    // `data: {…}` frame instead of the heartbeat comment, which the provider parses into
    // the same emitter `props.events.on("worktree.ready", …)` subscribes to.
    let deliverWorktreeReady = false
    const eventStreamOverride = async (route: import("@playwright/test").Route) => {
      if (!api(route.request())) return route.continue()
      const body = deliverWorktreeReady
        ? `data: ${JSON.stringify({ type: "worktree.ready", directory: MISSING_DIR, name: "recovered", branch: "main" })}\n\n`
        : ": heartbeat\n\n"
      await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
    }
    await page.route("**/global/event?**", eventStreamOverride)
    await page.route("**/event?**", eventStreamOverride)
    await page.route("**/api/wr/events**", eventStreamOverride)
    await page.route("**/api/claxedo/events**", eventStreamOverride)

    await openApp(page)
    await groupByWorkspace(page)

    const row = page.locator('[data-testid="workspace-header"][data-workspace-id="' + MISSING_DIR + '"]')
    await expect(row).toBeVisible({ timeout: 15_000 })
    // "New session in" is part of the engagement-mounted action cluster, so hover the
    // header to mount it.
    await row.hover()
    await row.getByRole("button", { name: /^New session in /, exact: false }).click()

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("Worktree not found")
    await expect(page.getByText(/The backing worktree for/)).toBeVisible()
    await page.screenshot({ path: "test-results/evidence/core-workspace-lifecycle/recover-workspace-dialog.png" })

    await page.getByRole("button", { name: "Continue in new worktree", exact: true }).click()

    await expect.poll(() => createBody, { timeout: 10_000 }).toBeTruthy()

    deliverWorktreeReady = true

    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 20_000 })
    // Recovery creates a new local workspace identity for the project. The
    // authoritative resolve response above carries that opaque route ID;
    // filesystem directories never leak into browser URLs.
    await expect(page).toHaveURL(`/w/local-${PROJECT_ID}`, { timeout: 10_000 })
  })
})
