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
  // 1728x1000 is a plain "more room for a marketing shot" bump. Note it does NOT by
  // itself fix either layout problem the captures hit: the workspace panel takes a
  // PERCENTAGE of the width, so widening the window scales both columns and leaves
  // the composer's container query exactly as tripped, and the WorkGraph tile has a
  // FIXED height, so extra width changes nothing about what its list clips. Both are
  // fixed where they are caused — the panel resize below, and the fixture titles.
  test.use({ viewport: { width: 1728, height: 1000 }, deviceScaleFactor: 3, colorScheme: "dark" })

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
    await expectDefaultTheme(page)

    const prompt = "Prepare the release verification flow and summarize the evidence for review."
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.fill(prompt)
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, /Release verification is ready/)
    await expect(page).toHaveURL(new RegExp(`/(?:s/|session/)${sessionId}$`), { timeout: 20_000 })
    await expect(page.locator('[data-testid="review-pane-empty"]')).toBeHidden()

    // The workspace panel rests at 70% of available width (workspace-panel.tsx
    // `defaultWidth`), leaving the chat column at 440px — under the 560px container
    // query in styles/index.css that collapses every composer control to a bare icon.
    // The capture then shows a naked shield and a clipped "C." where "Approve for me"
    // and the model name belong, so the panel has to be narrowed before the shot.
    //
    // Two ways NOT to do it. `Home` jumps to `minWidth`, which crushes the diff into
    // an unreadable sliver. And stepping while re-reading the width bottoms out just
    // the same: the panel animates over 120ms, so a read-after-press loop keeps
    // seeing a stale width and keeps pressing. Compute the press count up front from
    // the deficit (the separator moves a fixed RESIZE_KEY_STEP = 24px per
    // ArrowRight), then poll the settled width. Blur so no focus ring is in frame.
    const panelSeparator = page.getByRole("separator", { name: "Resize workspace panel" })
    const composerWidth = () =>
      page.evaluate(() => {
        const frame = document.querySelector('[data-component="composer-frame"]')
        return frame ? Math.round(frame.getBoundingClientRect().width) : 0
      })
    const TARGET_COMPOSER = 720
    const presses = Math.ceil(Math.max(0, TARGET_COMPOSER - (await composerWidth())) / 24)
    for (let step = 0; step < presses; step++) await panelSeparator.press("ArrowRight")
    await expect.poll(composerWidth).toBeGreaterThan(640)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    await page.locator("[data-claxedo]").screenshot({
      path: path.join(screenshots, "marketing-workspace.png"),
      animations: "disabled",
    })

    // `claxedo.sidebar.toggle` is registered as "mod+b", and parseKeybind maps
    // `mod` to Meta on macOS / Control elsewhere (providers/command-palette.tsx).
    // A hardcoded "Control+b" therefore matches nothing on a mac, which is where
    // this capture is normally run: the switcher never appears and the split
    // capture dies at the assertion below. ControlOrMeta resolves per-platform.
    await page.keyboard.press("ControlOrMeta+b")
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
    await expect(page.getByRole("button", { name: "Expand Environment" })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Session environment" })).toHaveClass(/\bis-collapsed\b/)
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
    await expectDefaultTheme(page)
    await expect(page.getByRole("article", { name: "Stream Ship Claxedo Cloud" })).toBeVisible()
    await expect(page.getByRole("article", { name: "Stream Prepare desktop release" })).toBeVisible()
    await expect(page.getByRole("article", { name: "Stream Polish launch story" })).toBeVisible()
    // What actually ruins this capture is a row SLICED by the tile's clip edge (the
    // previous one shipped "checksums" cut through the middle). Assert that directly:
    // every task row must be wholly inside the clipping container or wholly outside
    // it. `toBeVisible` cannot express this — the tile clips with `overflow: hidden`,
    // and a row cut in half is still "visible" to Playwright, so asserting on the
    // last row's text passes while the picture is broken.
    const slicedRows = await page.evaluate(() => {
      const list = document.querySelector(".workgraph-streamcard-tasks")
      if (!list) return ["no task list"]
      const clip = list.getBoundingClientRect()
      return Array.from(list.querySelectorAll(".workgraph-leaf"))
        .map((row) => ({ text: row.textContent?.trim() ?? "", box: row.getBoundingClientRect() }))
        .filter(({ box }) => box.top < clip.bottom - 1 && box.bottom > clip.bottom + 1)
        .map(({ text }) => text)
    })
    expect(slicedRows, "task rows sliced by the stream card's clip edge").toEqual([])
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

// These captures are the public site's product shots, so they must show the app's
// DEFAULT theme — whatever `ThemeProvider defaultTheme` is set to in entry/app.tsx.
// `seedProject` clears localStorage, so no stored `opencode-theme-id` can override
// it here; this asserts the result rather than trusting that. Themes only differ by
// colour, so a drift back to the old default would produce a perfectly valid-looking
// screenshot in the wrong palette — nothing else in this file would catch it.
async function expectDefaultTheme(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ""))
    .toBe("codex")
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
  const handler = (route: Route) => {
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
  }
  await page.route("**/api/control/session-list**", handler)
  // Loopback transports rewrite the path to /api/claxedo/session-list
  // (workspace-control-routes.ts:150) — same handler serves both.
  await page.route("**/api/claxedo/session-list**", handler)
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
    // This stream deliberately carries FEWER tasks than the card previews.
    // `STREAM_CARD_TASK_PREVIEW` is 4, but the card is a fixed 17.5rem tile
    // (workgraph.css `.workgraph-streamcard`) that clips its list, and the
    // compiled-settings chip row above it now wraps to two lines. A 4th row no longer
    // fits: it lands ON the clip edge and ships a word sliced through the middle,
    // which is what the previous capture did with "checksums". Shortening titles only
    // moves the slice around — the row count is the real constraint. Three rows plus
    // "Show N more" reads as a populated stream anyway. The clip-edge assertion in
    // the test enforces this, so adding a task here will fail the capture, not
    // silently spoil it.
    // Keep at least one `completed` task: the card footer shows a done/total
    // fraction, and an all-pending stream renders "0/3", which reads as a stream
    // where nothing has happened yet — not the picture the site wants.
    task("task_continuity", "stream_cloud", "Verify continuity", "completed"),
    task("task_announce", "stream_cloud", "Draft the announcement", "pending_approval"),
    stream("stream_desktop", "Prepare desktop release", "Package, sign, and verify the next desktop build.", "active"),
    task("task_package", "stream_desktop", "Package macOS and Linux builds", "active"),
    task("task_smoke", "stream_desktop", "Run installer smoke tests", "pending", ["task_package"]),
    stream("stream_launch", "Polish launch story", "Make the product's differentiated story clear at a glance.", "active"),
    task("task_guides", "stream_launch", "Review the product narrative", "completed"),
    task("task_examples", "stream_launch", "Verify the interactive hero", "active"),
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
