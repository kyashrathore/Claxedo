/**
 * SPEC: deterministic marketing captures (capture tool, NOT a regression test)
 *
 * LANE — `@marketing`, deliberately outside the `@core` CI lane and outside `@live`.
 * This file is a screenshot generator: it writes PNGs straight into
 * `packages/claxedo-web/public/screenshots`, i.e. it mutates committed source-tree
 * assets. Running it in CI would rewrite those assets on every shard, and running it in
 * a shard would race the other shards writing the same paths. Run it on purpose, when
 * the marketing captures need refreshing: `bun run test:e2e:marketing`. It asserts only
 * enough (via the shared turn oracle) to prove the captured surfaces really rendered.
 */
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import path from "node:path"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const directory = "/tmp/claxedo-marketing/northstar"
const sessionId = "ses_claxedo_marketing"
const screenshots = path.resolve(import.meta.dirname, "../../../claxedo-web/public/screenshots")

test.describe.serial("@marketing deterministic public-site captures", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3, colorScheme: "dark" })

  test("captures a seeded agent session and a chat-terminal split", async ({ page }) => {
    await seedProject(page)
    await installMockRuntime(page, {
      dir: directory,
      sessionId,
      projectId: "northstar",
      projectName: "Northstar",
      harness: "codex-acp",
      replyText: () =>
        "Release verification is ready. The acceptance checks pass, the deployment notes are updated, and the review evidence is attached.",
    })
    await installTerminalSocket(page)
    await installPtyApi(page)
    await installReviewApi(page)
    await installMarketingSessionList(page)
    await openWorkspace(page)
    await suppressCaptureOnlyConnectionNotice(page)

    const prompt = "Prepare the release verification flow and summarize the evidence for review."
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.fill(prompt)
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, /Release verification is ready/)
    await expect(page).toHaveURL(new RegExp(`/(?:s/|session/)${sessionId}$`), { timeout: 20_000 })
    await expect(page.locator('[data-testid="review-pane-empty"]')).toBeHidden()

    await page.locator("[data-claxedo]").screenshot({
      path: path.join(screenshots, "marketing-workspace.png"),
      animations: "disabled",
    })

    await page.keyboard.press("Control+b")
    await expect(page.locator('[data-testid="compact-switcher"]')).toBeVisible()
    // "New Terminal" left the dropdown for its own button, which opens the
    // creator; the shell tile is the plain login shell the screenshot wants.
    await page.locator('[data-testid="workspace-scope-new-terminal"]').first().click()
    const launchers = page.locator('[data-component="terminal-new-launchers"]')
    await expect(launchers).toBeVisible({ timeout: 20_000 })
    await launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="shell"]').first().click()
    const terminal = page.locator('[data-testid="terminal-pane"]').last()
    await expect(terminal).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="compact-switcher-tab"]')).toHaveCount(2)
    await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __marketingTerminalReady?: boolean }).__marketingTerminalReady))).toBe(true)

    const sessionTab = page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])').first()
    await sessionTab.click()
    const terminalTab = page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])').first()
    const sessionContent = page
      .locator("[data-workbench-content][data-pane-id]")
      .filter({ has: page.getByRole("textbox", { name: /Ask anything/i }) })
    await dragToRightEdge(terminalTab, sessionContent)
    await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible()

    const command = "codex --resume release-verification"
    await terminal.locator(".xterm-screen").click()
    await page.keyboard.type(command, { delay: 20 })
    await page.keyboard.press("Enter")
    await expect(terminal.locator(".xterm-screen")).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __marketingTerminalSends?: string }).__marketingTerminalSends ?? "")).toContain(command)
    const collapseEnvironment = page.getByRole("button", { name: "Collapse Environment" })
    if (await collapseEnvironment.isVisible()) await collapseEnvironment.click()
    await expect(page.getByRole("complementary", { name: "Session environment" })).toBeHidden()
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      ;(window as typeof window & { __marketingTerminalPush?: (text: string) => void }).__marketingTerminalPush?.(
        "\u001b[36m~/northstar $\u001b[0m codex --resume release-verification\r\n\u001b[32m✓ Codex resumed release-verification\u001b[0m\r\nReviewing 3 changed files…\r\n",
      )
    })
    await page.waitForTimeout(300)
    await page.locator('[data-testid="workbench-root"]').screenshot({
      path: path.join(screenshots, "marketing-session-terminal.png"),
      animations: "disabled",
    })
  })

  test("captures a populated WorkGraph with work and a pending decision", async ({ page }) => {
    await seedProject(page)
    await installMockRuntime(page, { dir: directory, projectId: "northstar", projectName: "Northstar" })
    await installWorkGraphApi(page)

    await page.goto("/workgraph")
    await expect(page.getByRole("main", { name: "WorkGraph" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("article", { name: "Stream Ship Claxedo Cloud" })).toBeVisible()
    await expect(page.getByRole("article", { name: "Stream Prepare desktop release" })).toBeVisible()
    await expect(page.getByRole("article", { name: "Stream Publish framework docs" })).toBeVisible()
    await expect(page.getByText("Run cross-workspace access checks", { exact: true })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Workspace panel" })).toBeHidden()
    await page.getByRole("button", { name: "Collapse Needs you" }).click()
    await expect(page.getByRole("button", { name: "Expand Needs you" })).toBeVisible()

    await page.getByRole("article", { name: "Stream Ship Claxedo Cloud" }).screenshot({
      path: path.join(screenshots, "marketing-workgraph.png"),
      animations: "disabled",
    })
  })
})

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedProject(page: Page) {
  await page.addInitScript((dir: string) => {
    localStorage.clear()
    localStorage.setItem("claxedo.terminal.screen-reader-mode", "1")
    localStorage.setItem("opencode.terminal.renderer", "dom")
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: dir, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, directory)
}

async function openWorkspace(page: Page) {
  await page.goto(`/${slug(directory)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 20_000 })
}

async function dragToRightEdge(tab: Locator, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error("Terminal pane has no drop target")
  await tab.dragTo(target, { targetPosition: { x: Math.max(1, box.width - 6), y: box.height / 2 } })
}

async function installTerminalSocket(page: Page) {
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __marketingTerminalReady?: boolean
      __marketingTerminalSends?: string
      __marketingTerminalPush?: (text: string) => void
    }
    browserWindow.__marketingTerminalReady = false
    browserWindow.__marketingTerminalSends = ""
    const OriginalWebSocket = window.WebSocket
    const FakeWebSocket = new Proxy(OriginalWebSocket, {
      construct(_target, args: [string | URL, (string | string[])?]) {
        const url = String(args[0])
        if (!url.includes("/api/wr/pty/") || !url.includes("/connect")) return Reflect.construct(OriginalWebSocket, args)
        const target = new EventTarget() as EventTarget & {
          url: string
          readyState: number
          send: (data: string) => void
          close: () => void
          onopen: ((event: Event) => void) | null
          onclose: ((event: CloseEvent) => void) | null
          onerror: ((event: Event) => void) | null
          onmessage: ((event: MessageEvent) => void) | null
        }
        target.url = url
        target.readyState = 0
        target.onopen = null
        target.onclose = null
        target.onerror = null
        target.onmessage = null
        const push = (data: string | ArrayBuffer) => {
          if (target.readyState !== 1) return
          const message = new MessageEvent("message", { data })
          target.onmessage?.(message)
          target.dispatchEvent(message)
        }
        browserWindow.__marketingTerminalPush = push
        target.send = (data: string) => {
          browserWindow.__marketingTerminalSends += data
          setTimeout(() => push(data), 15)
        }
        target.close = () => { target.readyState = 3 }
        setTimeout(() => {
          target.readyState = 1
          browserWindow.__marketingTerminalReady = true
          const open = new Event("open")
          target.onopen?.(open)
          target.dispatchEvent(open)
          const cursor = new TextEncoder().encode(JSON.stringify({ cursor: 0 }))
          const frame = new Uint8Array(cursor.length + 1)
          frame.set(cursor, 1)
          push(frame.buffer)
          setTimeout(() => push("\u001b[36m~/northstar $ \u001b[0m"), 25)
        }, 50)
        return target
      },
    })
    Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket })
  })
}

async function installPtyApi(page: Page) {
  let nextId = 1
  await page.route("**/api/wr/pty**", async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "POST" && url.pathname === "/api/wr/pty") {
      const body = request.postDataJSON() as { title?: string; cwd?: string }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: `pty_marketing_${nextId++}`, title: "Codex terminal", cwd: body.cwd ?? directory }),
      })
    }
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 })
    return route.fulfill({ status: 200, contentType: "application/json", body: request.method() === "GET" ? "[]" : "{}" })
  })
}

async function installReviewApi(page: Page) {
  const diffs = [
    {
      file: "src/release/verify.ts",
      additions: 58,
      deletions: 4,
      status: "modified",
      before: "export function verify() {\n  return false\n}",
      after: "export async function verifyRelease() {\n  const checks = await runAcceptanceChecks()\n  return checks.every((check) => check.passed)\n}",
    },
    {
      file: "docs/release-checklist.md",
      additions: 24,
      deletions: 2,
      status: "modified",
      before: "# Release\n\n- Build",
      after: "# Release verification\n\n- Desktop smoke test\n- Browser continuity\n- Self-hosted deployment\n- Checksums",
    },
    {
      file: "src/release/evidence.ts",
      additions: 31,
      deletions: 0,
      status: "added",
      before: "",
      after: "export const evidence = [\"desktop\", \"browser\", \"self-hosted\"]",
    },
  ]
  await page.route("**/api/wr/diff/**", async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/vcs")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(diffs) })
    }
    if (url.pathname.endsWith("/vcs/file")) {
      const file = url.searchParams.get("file")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(diffs.find((diff) => diff.file === file)) })
    }
    if (url.pathname.endsWith("/refs")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ branches: ["main"], tags: [], recent: [] }) })
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ defaultRef: "main", candidates: ["main"] }) })
  })
}

async function suppressCaptureOnlyConnectionNotice(page: Page) {
  await page.addStyleTag({ content: '[data-claxedo] [role="status"] { display: none !important; }' })
}

// The rail sidebar's session list is backed by GET /api/control/session-list — a
// claxedo-server-native endpoint distinct from the OpenCode /session route that
// installMockRuntime seeds. mock-runtime defaults it to an EMPTY list, so without
// this override the marketing capture shows "No sessions match the current view."
// beside a live session. Seed the active session (with a real title) so the hero
// sidebar reflects the workspace. Registered after installMockRuntime so it wins
// Playwright's last-registered-first route matching.
async function installMarketingSessionList(page: Page) {
  await page.route("**/api/control/session-list**", (route: Route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 },
        items: [
          {
            type: "session",
            sessionRef: sessionId,
            sessionId,
            projectId: "northstar",
            title: "Prepare release verification",
            directory,
            createdAt: 1_784_638_000_000,
            updatedAt: 1_784_638_400_000,
            tags: [],
            attachments: [],
          },
        ],
        totalKnown: 1,
      }),
    })
  })
}

async function installWorkGraphApi(page: Page) {
  const provenance = { actor: { type: "user", id: "local" } }
  const owner = {
    schemaVersion: 1,
    ownerUserId: "local",
    version: 1,
    createdAt: 1_784_638_000_000,
    updatedAt: 1_784_638_400_000,
    provenance,
  }
  const contract = {
    version: 1,
    mode: "all",
    requirements: [{ id: "release-review", kind: "owner_confirmation", description: "Release evidence is reviewed" }],
  }
  const task = (id: string, streamId: string, title: string, state: string, dependencyIds: string[] = []) => ({
    recordType: "work_item",
    ...owner,
    id,
    streamId,
    title,
    state,
    priority: 1,
    dependencyIds,
    sourceRevisionRefs: [],
    completionContract: contract,
    evidenceIds: [],
  })
  const stream = (id: string, title: string, description: string, lifecycleState = "paused", pinned = false) => ({
    recordType: "stream",
    ...owner,
    id,
    title,
    description,
    lifecycleState,
    visibility: "visible",
    pinned,
    executionDefaults: {},
    activity: { lastActivityAt: 1_784_638_400_000 },
    durableEffectCount: 2,
    sourceRevisionRefs: [],
  })
  const reviewTask = task("task_review", "stream_cloud", "Review deployment evidence", "review_needed")
  const records = [
    stream("stream_cloud", "Ship Claxedo Cloud", "Verify the product, publish the release, and preserve the evidence.", "paused", true),
    reviewTask,
    task("task_continuity", "stream_cloud", "Verify desktop and browser continuity", "completed"),
    task("task_checksums", "stream_cloud", "Publish release checksums", "pending"),
    task("task_access", "stream_cloud", "Run cross-workspace access checks", "pending", ["task_checksums"]),
    task("task_announce", "stream_cloud", "Prepare the launch announcement", "pending_approval"),
    stream("stream_desktop", "Prepare desktop release", "Package, sign, and verify the next desktop build.", "active"),
    task("task_package", "stream_desktop", "Package macOS and Linux builds", "active"),
    task("task_smoke", "stream_desktop", "Run installer smoke tests", "pending", ["task_package"]),
    stream("stream_framework", "Publish framework docs", "Turn the framework into a clear self-hosting path.", "active"),
    task("task_guides", "stream_framework", "Review the deployment guides", "completed"),
    task("task_examples", "stream_framework", "Verify framework examples", "active"),
    stream("stream_protocol", "Harden ACP support", "Test more agents against the shared chat surface."),
    task("task_acp", "stream_protocol", "Run ACP compatibility checks", "pending"),
  ]
  const decision = {
    recordType: "decision",
    ...owner,
    id: "decision_ship",
    streamId: "stream_cloud",
    state: "pending",
    question: "Is the release evidence sufficient to ship?",
    options: [
      { id: "ship", label: "Ship the release", description: "Continue with the verified release candidate." },
      { id: "hold", label: "Hold for review", description: "Collect another verification pass." },
    ],
    recommendationOptionId: "ship",
    rationale: "Desktop, browser, and self-hosted verification are complete.",
    affectedWorkItemIds: ["task_review"],
    sourceRevisionRefs: [],
  }

  await page.route("**/api/workgraph/**", async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes("/attention")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { ownerUserId: "local", id: decision.id, updatedAt: owner.updatedAt, kind: "decision", record: decision },
            { ownerUserId: "local", id: "task_review", updatedAt: owner.updatedAt, kind: "work_item", record: reviewTask },
          ],
          total: 2,
          hasMore: false,
        }),
      })
    }
    if (url.pathname.includes("/execution-capabilities")) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "execution_capabilities_unavailable", message: "Capture fixture", retryable: false, capability: "runtime", reason: "runtime_unavailable" } }) })
    }
    if (url.pathname.includes("/decisions/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(decision) })
    }
    if (url.pathname.endsWith("/defaults")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recordType: "workgraph", ...owner, id: "workgraph_default", defaults: { execution: {} } }) })
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        snapshotCursor: "marketing_capture_1",
        records,
        references: records.map((record, index) => ({ sequence: index + 1, resource: { type: record.recordType, id: record.id }, version: record.version })),
        hasMore: false,
        capturedAt: owner.updatedAt,
      }),
    })
  })
}
