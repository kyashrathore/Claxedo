import { chromium, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import path from "node:path"

const BASE = "http://127.0.0.1:4455"
const OUT = path.resolve(import.meta.dir, "../../../docs/plans/evidence")
const DIR = "/tmp/capture-project"

const drivers = (configured: boolean) => ({
  default_driver: "daytona",
  drivers: [{
    id: "daytona",
    label: "Daytona",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
    configured,
    source: "local",
    default: true,
  }],
})

const integrations = (connected: boolean) => ({
  integrations: [{
    id: "github",
    name: "GitHub",
    methods: ["key"],
    capabilities: ["code-host", "work-source"],
    prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
  }],
  connections: connected
    ? [{
      id: "conn-1",
      integrationId: "github",
      scope: "team",
      accountLabel: "kyashrathore",
      grantedCapabilities: ["code-host"],
      fields: {},
      status: "connected",
      createdAt: 0,
      updatedAt: 0,
    }]
    : [],
  personalScopeEnabled: false,
})

type Scenario = {
  name: string
  destination?: "local" | "both"
  sandboxConfigured?: boolean
  codeHostConnected?: boolean
}

const scenarios: Scenario[] = [
  { name: "01-unanswered" },
  { name: "02-said-no", destination: "local" },
  { name: "03-said-yes-nothing-yet", destination: "both" },
  { name: "04-said-yes-key-saved", destination: "both", sandboxConfigured: true },
  { name: "05-said-yes-ready", destination: "both", sandboxConfigured: true, codeHostConnected: true },
]

async function describe(page: Page, label: string) {
  const counter = await page.locator(".setup-counter").textContent().catch(() => null)
  const title = await page.locator(".setup-title").textContent().catch(() => null)
  const rail = await page.locator(".setup-rail-segment").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-state")))
  const footer: string[] = []
  for (const button of await page.locator(".setup-actions button").all()) {
    const text = (await button.textContent())?.trim()
    const disabled = await button.isDisabled()
    const hint = await button.getAttribute("title")
    footer.push(`${text}${disabled ? " (disabled)" : ""}${hint ? ` "${hint}"` : ""}`)
  }
  console.log(`${label}\n  ${counter} · ${title}\n  rail ${JSON.stringify(rail)}\n  footer ${footer.join(" | ")}`)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  for (const theme of ["dark", "light"] as const) {
    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme })
      const page = await context.newPage()

      await page.route("**/api/claxedo/credentials**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ credentials: [] }) }))
      await page.route("**/api/workspace/drivers**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(drivers(scenario.sandboxConfigured === true)),
        }))
      await page.route("**/api/claxedo/integrations**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(integrations(scenario.codeHostConnected === true)),
        }))

      await page.addInitScript((input: { dir: string; destination?: string }) => {
        localStorage.clear()
        ;(window as typeof window & { __OPENCODE__?: unknown }).__OPENCODE__ = {
          serverUrl: window.location.origin,
          activeDirectory: input.dir,
        }
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            list: [],
            projects: { local: [{ worktree: input.dir, expanded: true }] },
            lastProject: {},
            workspaceServer: {},
            closedProjects: {},
          }),
        )
        if (input.destination) {
          localStorage.setItem(
            "opencode.global.dat:onboarding.destination.v1",
            JSON.stringify({ destination: input.destination }),
          )
        }
      }, { dir: DIR, ...(scenario.destination ? { destination: scenario.destination } : {}) })

      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(6000)

      const name = `flow-v2-${scenario.name}-${theme}.png`
      await page.screenshot({ path: path.join(OUT, name) })
      if (theme === "dark") await describe(page, scenario.name)
      await context.close()
    }
  }

  await browser.close()
}

void main()
