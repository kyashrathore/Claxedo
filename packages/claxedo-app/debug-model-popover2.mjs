import { chromium } from "@playwright/test"

const DIR = "/tmp/e2e-debug-model-popover2"
const SESSION_ID = "ses_debug_model_popover2"
const PORT = 4455

function slug(value) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

function paidProviderBody() {
  return {
    all: [
      { id: "opencode", name: "opencode", env: [], models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", release_date: "2026-06-15", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } },
      { id: "anthropic", name: "Anthropic", env: [], models: {
        "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Sonnet 4.6", release_date: "2026-06-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 3, output: 15 }, options: {}, variants: { high: {}, low: {} } },
        "claude-opus-4-7": { id: "claude-opus-4-7", name: "Opus 4.7", release_date: "2026-06-02", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 15, output: 75 }, options: {} },
      } },
    ],
    default: { opencode: "big-pickle", anthropic: "claude-sonnet-4-6" },
    connected: ["opencode", "anthropic"],
  }
}

const browser = await chromium.launch()
const page = await browser.newPage()
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console-error]", msg.text()) })
page.on("request", (req) => { if (req.url().match(/\/provider(\?|$)/)) console.log("[request]", req.method(), req.url()) })
page.on("response", (res) => { if (res.url().match(/\/provider(\?|$)/)) console.log("[response]", res.status(), res.url()) })

await page.addInitScript((d) => {
  localStorage.clear()
  window.__OPENCODE__ = { serverUrl: window.location.origin, activeDirectory: d }
  localStorage.setItem("opencode.global.dat:server", JSON.stringify({
    list: [], projects: { local: [{ worktree: d, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {},
  }))
}, DIR)

function api(route) {
  const t = route.request().resourceType()
  return t === "fetch" || t === "xhr"
}

const body = paidProviderBody()
await page.route("**/provider**", (r) => {
  if (!api(r)) return r.continue()
  if (new URL(r.request().url()).pathname !== "/provider") return r.fallback()
  return json(r, body)
})
await page.route("**/api/claxedo/bootstrap**", (r) => api(r) ? json(r, {
  healthy: true, version: "1.0.0-test",
  path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
  project: [{ id: "proj_debug", worktree: DIR, name: "debug", time: { created: Date.now(), updated: Date.now() } }],
  provider: body,
  provider_auth: { opencode: [{ type: "api", label: "API key" }], anthropic: [{ type: "api", label: "API key" }] },
  config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
}) : r.continue())
await page.route("**/provider/auth", (r) => (api(r) ? json(r, {}) : r.continue()))
await page.route("**/path**", (r) => api(r) && new URL(r.request().url()).pathname === "/path" ? json(r, { worktree: DIR }) : r.continue())
await page.route("**/agent**", (r) => api(r) && ["/agent", "/app/agents"].includes(new URL(r.request().url()).pathname) ? json(r, [{ id: "build", name: "build", description: "Build agent" }]) : r.continue())
await page.route("**/config", (r) => api(r) && new URL(r.request().url()).pathname === "/config" ? json(r, { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } }) : r.continue())
await page.route("**/project**", (r) => api(r) && ["/project", "/experimental/project"].includes(new URL(r.request().url()).pathname) ? json(r, [{ id: "proj_debug", worktree: DIR, name: "debug", time: { created: Date.now(), updated: Date.now() } }]) : r.continue())
await page.route("**/mcp**", (r) => api(r) && new URL(r.request().url()).pathname === "/mcp" ? json(r, {}) : r.continue())
await page.route("**/lsp**", (r) => api(r) && new URL(r.request().url()).pathname === "/lsp" ? json(r, []) : r.continue())
await page.route("**/vcs**", (r) => api(r) && new URL(r.request().url()).pathname === "/vcs" ? json(r, {}) : r.continue())
await page.route("**/command**", (r) => api(r) && new URL(r.request().url()).pathname === "/command" ? json(r, [{ name: "build", description: "Build command" }]) : r.continue())
await page.route("**/permission**", (r) => api(r) && new URL(r.request().url()).pathname === "/permission" ? json(r, []) : r.continue())
await page.route("**/question**", (r) => api(r) && new URL(r.request().url()).pathname === "/question" ? json(r, []) : r.continue())
await page.route("**/api/workspace/resolve**", (r) => api(r) ? json(r, { workspaceId: `local-${SESSION_ID}`, directory: DIR, kind: "local", status: "ready" }) : r.continue())
await page.route("**/api/claxedo/agent-config/harness/options**", (r) => api(r) ? json(r, { source: "runner", stale: false, options: [] }) : r.continue())
await page.route("**/api/claxedo/agent-config/harness**", (r) => api(r) ? json(r, { type: "opencode", ok: true }) : r.continue())
await page.route("**/api/claxedo/agent-config/agents**", (r) => api(r) ? json(r, [{ id: "build", name: "build", mode: "primary" }]) : r.continue())
await page.route("**/api/claxedo/agent-config/commands**", (r) => api(r) ? json(r, [{ name: "build", description: "Build command" }]) : r.continue())
await page.route("**/session/status", (r) => api(r) ? json(r, {}) : r.continue())
await page.route("**/session", (r) => api(r) ? json(r, r.request().method() === "POST" ? { id: SESSION_ID, slug: SESSION_ID, projectID: "proj_debug", directory: DIR, title: "", version: "2", time: { created: Date.now(), updated: Date.now() }, summary: { additions: 0, deletions: 0, files: 0 } } : []) : r.continue())
await page.route("**/global/event?**", async (r) => {
  await r.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n` })
})
await page.route("**/event?**", async (r) => {
  await new Promise((res) => setTimeout(res, 4000))
  await r.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" })
})

await page.goto(`http://127.0.0.1:${PORT}/${slug(DIR)}/session`, { timeout: 60000 })
await page.waitForLoadState("domcontentloaded")
await page.waitForSelector("[data-claxedo]", { timeout: 30000 })
console.log("[info] app shell visible")

const trigger = page.locator('[data-action="prompt-model"]').last()
await trigger.waitFor({ state: "visible", timeout: 10000 })
console.log("[info] trigger text:", await trigger.textContent())
await trigger.click()

await page.waitForTimeout(3000)
const items = await page.locator('[data-slot="list-item"]').allTextContents()
console.log("[info] list items:", JSON.stringify(items))
const noResults = await page.getByText("No model results").isVisible().catch(() => false)
console.log("[info] No model results visible:", noResults)

await browser.close()
