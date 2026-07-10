import { expect, test, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-reload-budget"
const SAND = "/tmp/e2e-reload-budget-sandbox"
const SERVER = "http://localhost:4444"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function countDuplicates(keys: string[]) {
  const counts = new Map<string, number>()
  keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1))
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
}

async function seed(page: Page) {
  await page.addInitScript(({ dir, sand, server }) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: server,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          [server]: [
            { worktree: dir, expanded: true, sandboxes: [sand] },
            { worktree: sand, expanded: true },
          ],
        },
        lastProject: { [server]: dir },
        workspaceServer: {},
        closedProjects: {},
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:claxedo.state.v5",
      JSON.stringify({
        workbench: {
          panes: [{ id: "pane-session", contentId: "tab-session" }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane-session" } },
          contentIds: ["tab-session"],
          contentRecency: ["tab-session"],
          focusedPaneId: "pane-session",
          layoutSnapshots: {},
        },
        meta: {
          "tab-session": {
            id: "tab-session",
            type: "session",
            scope: "directory",
            directory: dir,
            sessionId: "ses_budget_1",
            content: {
              type: "session",
              directory: dir,
              sessionId: "ses_budget_1",
              title: "Budget session",
            },
          },
        },
        rail: { collapsed: false, hovered: false, pinned: false, locked: false },
        workspace: {
          paneWorktree: { "pane-session": { default: dir, pinned: null } },
          recency: {},
          worktreeColor: {},
        },
        workspacePanel: { open: true },
        terminal: { owner: {}, agentStatus: {}, agentSeen: {}, lifecycle: {} },
        processPane: {
          toggleVersion: 0,
          pendingOpen: false,
          targetDirectory: null,
          crashedWhileClosed: false,
          pendingAction: null,
        },
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        recent: [{ providerID: "opencode", modelID: "gpt-test" }],
        user: [],
        variant: {},
      }),
    )
  }, { dir: DIR, sand: SAND, server: SERVER })
}

async function setup(page: Page) {
  const sessions = [
    {
      id: "ses_budget_1",
      title: "Budget session",
      directory: DIR,
      projectID: "proj_budget",
      time: { created: Date.now(), updated: Date.now() },
      parentID: null,
    },
  ]
  const provider = {
    all: [{
      id: "opencode",
      name: "OpenCode",
      models: {
        "gpt-test": {
          id: "gpt-test",
          name: "GPT Test",
          providerID: "opencode",
        },
      },
    }],
    connected: [],
    default: { opencode: "gpt-test" },
  }
  const api = (route: Route) => ["fetch", "xhr", "eventsource"].includes(route.request().resourceType())

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    const body = (() => {
      if (url.pathname.endsWith("/event")) return undefined
      if (url.pathname.endsWith("/global/health") || url.pathname.endsWith("/health")) {
        return { healthy: true, version: "1.0.0-test" }
      }
      if (url.pathname.endsWith("/api/claxedo/bootstrap")) {
        return {
          healthy: true,
          path: { state: "", config: "", worktree: DIR, directory: DIR, home: "" },
          project: [{ id: "proj_budget", name: "reload-budget", worktree: DIR, sandboxes: [SAND] }],
          provider,
          provider_auth: {},
          config: {},
        }
      }
      if (url.pathname.endsWith("/path")) {
        return { state: "", config: "", worktree: DIR, directory: DIR, home: "" }
      }
      if (url.pathname.endsWith("/project/current")) {
        return { id: "proj_budget", name: "reload-budget", worktree: DIR }
      }
      if (url.pathname.endsWith("/project")) {
        return [{ id: "proj_budget", name: "reload-budget", worktree: DIR, sandboxes: [SAND] }]
      }
      if (url.pathname.endsWith("/config")) return {}
      if (url.pathname.endsWith("/provider")) return provider
      if (url.pathname.endsWith("/provider/auth")) return {}
      if (url.pathname.endsWith("/app/agents")) return []
      if (url.pathname.endsWith("/session/status") || url.pathname.endsWith("/status")) return { ses_budget_1: { type: "idle" } }
      if (url.pathname.endsWith("/permission")) return []
      if (url.pathname.endsWith("/question")) return []
      if (url.pathname.endsWith("/session")) return sessions
      if (url.pathname.includes("/session/ses_budget_1/message")) return []
      if (url.pathname.includes("/session/ses_budget_1/todo")) return []
      if (url.pathname.endsWith("/api/workspace/resolve")) return { workspaceId: "ws_budget", kind: "local" }
      if (url.pathname.endsWith("/api/claxedo/agent-config/harness/model")) return { type: "opencode", ok: true }
      if (url.pathname.endsWith("/api/claxedo/pty")) return []
      if (url.pathname.includes("/api/claxedo/pty/")) return true
      return {}
    })()

    if (url.pathname.endsWith("/event")) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "data: {}\n\n",
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  })
}

test.describe("reload request budget", () => {
  test.skip("does not duplicate first-minute app-data requests after reload", async ({ page }) => {
    test.setTimeout(75_000)
    await seed(page)
    await setup(page)

    const keys: string[] = []
    page.on("request", (request) => {
      if (!["fetch", "xhr", "eventsource"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname.endsWith("/event")) return
      if (url.pathname.endsWith("/global/health") || url.pathname.endsWith("/health")) return
      if (url.pathname.includes("/api/claxedo/pty/") && request.method() === "PUT") return
      url.searchParams.sort()
      keys.push(`${request.method()} ${url.origin}${url.pathname}${url.search}`)
    })

    await page.goto(`/${slug(DIR)}/session/ses_budget_1`)
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(60_000)

    expect(countDuplicates(keys)).toEqual([])
  })
})
