import { chromium } from "@playwright/test"

function api(request) {
  const type = request.resourceType()
  return type === "fetch" || type === "xhr"
}
function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

const DIR = "/tmp/e2e-core-lifecycle-main"
const SECOND_DIR = "/tmp/e2e-core-lifecycle-second"
const PROJECT_ID = "proj_core_lifecycle"
const PROJECT_NAME = "core-lifecycle-main"

const proj = {
  id: PROJECT_ID,
  worktree: DIR,
  name: PROJECT_NAME,
  sandboxes: [SECOND_DIR],
  workspaces: { [SECOND_DIR]: { kind: "local", available: true, directory: SECOND_DIR } },
  time: { created: Date.now(), updated: Date.now() },
}

const bootstrapBody = {
  healthy: true,
  version: "1.0.0-test",
  path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
  project: [proj],
  provider: { all: [{ id: "opencode", name: "opencode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
    default: { opencode: "big-pickle" }, connected: ["opencode"] },
  provider_auth: { opencode: [{ type: "api", label: "API key" }] },
  config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
}

const browser = await chromium.launch()
const page = await browser.newPage()

await page.route("**/api/claxedo/bootstrap**", (r) => (api(r.request()) ? json(r, bootstrapBody) : r.continue()))
const handleProjectList = (r) => { if (!api(r.request())) return r.continue(); if (r.request().method() !== "GET") return r.fallback(); return json(r, [proj]) }
await page.route("**/project", handleProjectList)
await page.route("**/project?**", handleProjectList)
await page.route("**/project/current**", (r) => (api(r.request()) ? json(r, proj) : r.continue()))
await page.route("**/project/*", (r) => { if (!api(r.request())) return r.continue(); if (r.request().method() !== "PATCH") return r.fallback(); return json(r, proj) })
await page.route("**/experimental/project", handleProjectList)
await page.route("**/experimental/project?**", handleProjectList)
await page.route("**/health**", (r) => (api(r.request()) ? json(r, { healthy: true }) : r.continue()))
await page.route("**/find/file**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/path**", (r) => (api(r.request()) ? json(r, { worktree: DIR }) : r.continue()))
await page.route("**/agent**", (r) => (api(r.request()) ? json(r, [{ id: "build", name: "build" }]) : r.continue()))
await page.route("**/provider**", (r) => { if (!api(r.request())) return r.continue(); if (new URL(r.request().url()).pathname !== "/provider") return r.fallback(); return json(r, bootstrapBody.provider) })
await page.route("**/provider/auth**", (r) => (api(r.request()) ? json(r, bootstrapBody.provider_auth) : r.continue()))
await page.route("**/config**", (r) => { if (!api(r.request())) return r.continue(); if (new URL(r.request().url()).pathname !== "/config") return r.fallback(); return json(r, bootstrapBody.config) })
await page.route("**/mcp**", (r) => (api(r.request()) ? json(r, {}) : r.continue()))
await page.route("**/lsp**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/vcs**", (r) => (api(r.request()) ? json(r, {}) : r.continue()))
await page.route("**/command**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/permission**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/question**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/api/workspace/resolve**", (r) => (api(r.request()) ? json(r, { workspaceId: "local-x", directory: DIR, kind: "local", status: "ready" }) : r.continue()))
await page.route("**/api/claxedo/agent-config/**", (r) => (api(r.request()) ? json(r, { source: "runner", stale: false, options: [] }) : r.continue()))
const eventStreamHandler = async (route) => { if (!api(route.request())) return route.continue(); await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {}) }
await page.route("**/global/event?**", eventStreamHandler)
await page.route("**/event?**", eventStreamHandler)
await page.route("**/api/wr/events**", eventStreamHandler)
await page.route("**/api/wr/diff/**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/session", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/session?**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/experimental/session", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/experimental/session?**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/session/*/message**", (r) => (api(r.request()) ? json(r, []) : r.continue()))
await page.route("**/session/*/capabilities**", (r) => (api(r.request()) ? json(r, { transport: "opencode" }) : r.continue()))
await page.route("**/session/status**", (r) => (api(r.request()) ? json(r, {}) : r.continue()))
await page.route("**/api/control/session-list**", (r) => (api(r.request()) ? json(r, { view: {}, items: [], totalKnown: 0 }) : r.continue()))
await page.route("**/api/control/sessions**", (r) => (api(r.request()) ? json(r, []) : r.continue()))

function slug(value) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

await page.addInitScript((d) => {
  localStorage.clear()
  window.__OPENCODE__ = { serverUrl: window.location.origin, activeDirectory: d }
  localStorage.setItem("opencode.global.dat:server", JSON.stringify({
    list: [], projects: { local: [{ worktree: d, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {},
  }))
}, DIR)

await page.goto(`http://127.0.0.1:4455/${slug(DIR)}/session`, { waitUntil: "domcontentloaded", timeout: 30000 })
await page.waitForSelector("[data-claxedo]", { timeout: 20000 })
await page.waitForTimeout(2000)

await page.getByRole("button", { name: "View options" }).click()
await page.getByRole("menuitemradio", { name: "Workspace" }).click()
await page.keyboard.press("Escape")
await page.waitForTimeout(1500)

const headers = await page.locator('[data-testid="workspace-header"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-workspace-id")))
console.log("WORKSPACE HEADERS:", JSON.stringify(headers))

const projectsData = await page.evaluate(async () => {
  const res = await fetch("/project")
  return res.json()
})
console.log("PROJECT API RESPONSE:", JSON.stringify(projectsData))

await browser.close()
