/**
 * Workbench shell: panes, splits, the compact tab strip, focus, and header
 * chrome. What renders INSIDE a pane belongs to the `core-*` spec for that
 * content type; the sidebar tree belongs to `core-sidebar-tree`.
 *
 * Harness constraints:
 *   - `installMockRuntime` models exactly ONE session id end to end. Scenarios
 *     that need a second or third independently-addressable pane use an unsent
 *     draft (no network) and/or a mocked terminal, never a second chat session.
 *   - `openWorkbench` boots at `/<b64dir>/session` with NO trailing id. That
 *     route form does not own an initial surface, so `initialStateForPath`
 *     hydrates the persisted workbench instead of wiping it; adding an id to the
 *     URL would discard panes and splits on every load.
 *   - `wb.split.split()` no-ops when the dropped contentId equals the target
 *     pane's own content, so every path that creates a NEW split must supply a
 *     genuinely different content id: a dragged background switcher tab, or
 *     `mod+\` (which passes `wb.selectors.mruHiddenContent()` and therefore does
 *     nothing when no surface is hidden).
 *   - `mod+w` is registered independently by the Workbench's own window keydown
 *     listener, by the command palette's `claxedo.pane.close`, and by a
 *     session-scoped `tab.close`. Which one fires depends on component mount
 *     order, so these tests pin the observable end state, not the path taken.
 *   - An empty workbench re-opens a draft one microtask after it goes empty,
 *     unless `blockNextAutoOpen()` suppresses it for 2000ms (behavior 15).
 */
import { workspaceResolveRoute } from "../helpers/contracts/workspace-resolve"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { bootstrapDeployment, installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-panes-split-tabs"
const SESSION_ID = "ses_core_panes_split_tabs"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
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

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

/** Mocks the terminal PTY create route `/api/wr/pty` (not `/api/claxedo/pty`,
 * a stale path carried by a retired legacy fixture). Enough for a pane to mount
 * and activate; websocket I/O is not modeled — only `core-terminal` asserts
 * terminal I/O. The creator offers a launcher tile only for an agent named in
 * `GET /pty/agents`'s `installed`; the catch-all's `true` body reads as nothing
 * installed, and `startTerminalFromCreator` presses the claude and codex tiles. */
function installPtyMock(page: Page) {
  let counter = 0
  return page.route("**/api/wr/pty**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname.endsWith("/api/wr/pty/agents")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ installed: ["claude", "codex"] }),
      })
      return
    }
    if (request.method() === "POST" && url.pathname.endsWith('/api/wr/pty')) {
      counter += 1
      const body = request.postDataJSON?.() as { title?: string } | undefined
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: `pty_test_${counter}`, title: body?.title ?? `Terminal ${counter}`, cwd: DIR }),
      })
      return
    }
    // connect / update / delete sub-routes: harmless 200s, no websocket modeled.
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
}

function switcherTabs(page: Page) {
  return page.locator('[data-testid="compact-switcher-tab"]')
}

function activeTitleButton(page: Page) {
  return page.locator('[data-testid="switcher-title-button"][aria-current="page"]')
}

function backgroundTitleButtons(page: Page) {
  return page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])')
}

function visiblePaneContents(page: Page) {
  return page.locator("[data-workbench-content][data-pane-id]")
}

/** Playwright's bundled Chromium reports `navigator.platform === "Win32"` in
 * this harness regardless of the host OS (same finding as `core-settings-
 * auth.spec.ts`'s "behavior 11" comment; see `src/context/command-
 * upstream.tsx`'s `IS_MAC = /(Mac|iPod|iPhone|iPad)/.test(navigator.
 * platform)`) — so `mod` in every shortcut routed through the command
 * registry (`rail-keyboard-commands.ts`: mod+tab, mod+shift+tab, mod+<N>,
 * mod+b, the palette keybind itself) resolves to Ctrl in-app even when the
 * TEST PROCESS is macOS. The Workbench's own raw keydown listener
 * (`layout/keyboard.ts`'s `matchKey`) accepts either modifier by design, so
 * mod+w / mod+alt+Arrow* (which ALSO have a command-registry duplicate that
 * never fires here) still work with either key — but mod+tab/mod+shift+tab/
 * mod+<N>/mod+b/mod+shift+p have NO raw-listener fallback and silently do
 * nothing if the wrong modifier is pressed. Resolve at runtime instead of
 * trusting `process.platform`. */
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  return isMac ? "Meta" : "Control"
}

/** The compact switcher tab strip (`[data-testid="compact-switcher-tab"]`)
 * only renders while the RailSidebar is UNPINNED —
 * `workbench-shell-header.tsx` wraps both the "Show Sidebar" button and
 * `<CompactSwitcher>` in a single `<Show when={!sidebarPinned()}>` (the full
 * sidebar tree already doubles as the tab navigator while pinned open; see
 * `src/shell/layout/config.ts`'s `docked: rail.pinned === true` and the
 * default-pinned rail state in `src/claxedo-ui/state/persistence.ts`'s
 * `defaultRail()`, which is what every freshly-seeded project in this spec
 * boots with). Every scenario that reads switcher tabs must unpin the sidebar
 * first; while it is pinned, `compact-switcher-tab` matches 0 elements. */
async function unpinSidebarForSwitcher(page: Page) {
  const mod = await modKey(page)
  await page.keyboard.press(`${mod}+b`)
  await expect(page.locator('[data-testid="compact-switcher"]')).toBeVisible({ timeout: 10_000 })
}

async function dragTabOntoRightEdge(page: Page, tab: Locator, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error("drop target has no bounding box")
  await tab.dragTo(target, { targetPosition: { x: Math.max(1, box.width - 6), y: box.height / 2 } })
}

/**
 * Starts a terminal through the creator, the only entry point there is: the
 * header's single `New Terminal` button opens the launcher tiles rather than
 * starting a pty, because its own directory comes from a fallback chain the
 * person clicking cannot see. The creator turns THAT surface into the terminal
 * in place — same content id, so the tab and pane counts these scenarios assert
 * on are unchanged.
 */
async function startTerminalFromCreator(page: Page, preset: "claude" | "codex") {
  await page.locator('[data-testid="workspace-scope-new-terminal"]').first().click()
  const launchers = page.locator('[data-component="terminal-new-launchers"]')
  await expect(launchers).toBeVisible({ timeout: 20_000 })
  await launchers.locator(`[data-slot="terminal-launcher"][data-launcher-id="${preset}"]`).first().click()
}

async function buildDraftPlusTerminalSplit(page: Page) {
  // These panes stay inert, but the shell still boots through a health poll and a
  // workspace resolve that `installPtyMock` does not serve; without them the route lands
  // on `ConnectionError`. `installMockRuntime` supplies that boot surface. Its modelled
  // session id goes unused here.
  await seedOneProject(page, DIR)
  await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
  await installPtyMock(page)
  await openWorkbench(page, DIR)
  await unpinSidebarForSwitcher(page)
  await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })

  await startTerminalFromCreator(page, "claude")
  await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
  await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })

  const draftTab = backgroundTitleButtons(page).first()
  const terminalContent = page.locator('[data-workbench-content][data-pane-id]').filter({ has: page.locator('[data-testid="terminal-pane"]') })
  await dragTabOntoRightEdge(page, draftTab, terminalContent)

  await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
  await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })
  return {
    sessionContent: page.locator('[data-testid="session-content"][data-session-id="new"]'),
    terminalContent: page.locator('[data-testid="terminal-pane"]'),
  }
}

/** Sends a first prompt (promoting the draft to a real SESSION_ID surface, driven to
 * `idle`), then opens a fresh draft so SESSION_ID is a backgrounded, unfocused switcher
 * tab. Returns the mock plus a locator for that tab and a reader for its status dot. */
async function establishBackgroundedSession(page: Page, beforeUnpin?: (page: Page) => Promise<void>) {
  await seedOneProject(page, DIR)
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harness: "acp:codex" })
  await installPtyMock(page)
  await openWorkbench(page, DIR)
  await beforeUnpin?.(page)
  await unpinSidebarForSwitcher(page)

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill("establish session")
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: establish session")

  // Capture the real session tab's title while it is still the sole (active)
  // tab, so we can target that exact tab by a stable identity even after focus
  // changes flip which tab carries `aria-current="page"`.
  await expect(activeTitleButton(page)).toBeVisible({ timeout: 10_000 })
  const sessionTabTitle = await activeTitleButton(page).getAttribute("aria-label")
  if (!sessionTabTitle) throw new Error("establishBackgroundedSession: no session tab title")

  // Open a fresh draft so the real session tab is unfocused/backgrounded.
  await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })

  const sessionTab = page.locator('[data-testid="compact-switcher-tab"]').filter({
    has: page.locator(`[data-testid="switcher-title-button"][aria-label="${sessionTabTitle}"]`),
  })
  const sessionDot = sessionTab.locator('[data-switcher-status]')
  const sessionDotStatus = async () => (await sessionDot.getAttribute("data-switcher-status").catch(() => null)) ?? "none"
  return { mock, sessionTab, sessionDot, sessionDotStatus, sessionTabTitle }
}

async function installMockAudioPlayback(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & { __audioPlayCount__?: number }
    target.__audioPlayCount__ = 0

    class MockAudio {
      currentTime = 0
      constructor(readonly src: string) {}
      play() {
        target.__audioPlayCount__ = (target.__audioPlayCount__ ?? 0) + 1
        return Promise.resolve()
      }
      pause() {}
    }

    Object.defineProperty(window, "Audio", {
      configurable: true,
      writable: true,
      value: MockAudio,
    })
  })
}

function audioPlayCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __audioPlayCount__?: number }).__audioPlayCount__ ?? 0)
}

async function selectAgentCompletionSound(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const surface = page.locator('[data-component="settings-content"]')
  await expect(surface).toBeVisible({ timeout: 10_000 })

  const trigger = surface.locator('[data-action="settings-sounds-agent"] [data-slot="select-select-trigger"]')
  await trigger.click()
  await page.locator('[data-slot="select-select-item"]').first().click()
  await expect(trigger).toContainText("Alert 01")

  await page.locator('[data-action="settings-nav-back"]').click()
  await expect(surface).toHaveCount(0, { timeout: 5_000 })
}

test.describe("core panes: split, tabs, focus, shell chrome @core", () => {
  test("dragging a background tab onto a pane's edge splits the workbench", async ({ page }) => {
    const { sessionContent, terminalContent } = await buildDraftPlusTerminalSplit(page)
    await expect(sessionContent).toBeVisible()
    await expect(terminalContent).toBeVisible()
    await expect(switcherTabs(page)).toHaveCount(2)
  })

  test("dragging the resize divider changes the split ratio", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    const divider = page.locator('[data-testid="workbench-divider"]')
    const panes = visiblePaneContents(page)
    const before = await panes.nth(0).boundingBox()
    expect(before).not.toBeNull()

    const dBox = await divider.boundingBox()
    expect(dBox).not.toBeNull()
    if (!dBox || !before) return
    const cx = dBox.x + dBox.width / 2
    const cy = dBox.y + dBox.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 160, cy, { steps: 8 })
    await page.mouse.up()

    await expect
      .poll(async () => {
        const after = await panes.nth(0).boundingBox()
        return after ? Math.round(after.width) : null
      }, { timeout: 10_000 })
      .not.toBe(Math.round(before.width))
  })

  test("focusing a pane dims the other pane's content slot", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    const panes = visiblePaneContents(page)
    const first = panes.nth(0)
    const second = panes.nth(1)

    // `visiblePaneContents` is ordered by `contentIds` insertion (creation)
    // order, not pane order: the draft session is opened first by the empty
    // workbench and the terminal second, so `first` is the draft slot and
    // `second` the terminal slot whichever pane each currently occupies.
    // `wb.split.split` focuses the NEWLY inserted pane — here the draft's,
    // since the draft was the background tab dragged onto the terminal's edge.
    await expect(async () => {
      const [firstOpacity, secondOpacity] = await Promise.all([
        first.evaluate((element) => getComputedStyle(element).opacity),
        second.evaluate((element) => getComputedStyle(element).opacity),
      ])
      expect(firstOpacity).toBe("1")
      expect(secondOpacity).toBe("0.55")
    }).toPass({ timeout: 10_000 })

    await second.click()
    await expect(async () => {
      const [firstOpacity, secondOpacity] = await Promise.all([
        first.evaluate((element) => getComputedStyle(element).opacity),
        second.evaluate((element) => getComputedStyle(element).opacity),
      ])
      expect(firstOpacity).toBe("0.55")
      expect(secondOpacity).toBe("1")
    }).toPass({ timeout: 10_000 })
  })

  test("mod+alt+ArrowLeft/Right move focus between split panes", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    const panes = visiblePaneContents(page)
    const first = panes.nth(0)
    const second = panes.nth(1)

    const isDim = async (locator: Locator) => ((await locator.getAttribute("class")) ?? "").includes("opacity-55")
    const mod = await modKey(page)

    // Whichever pane is focused right after the split, mod+alt+ArrowLeft moves
    // focus toward the geometrically LEFT pane.
    await page.keyboard.press(`${mod}+Alt+ArrowLeft`)
    await expect.poll(() => isDim(second), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => isDim(first), { timeout: 10_000 }).toBe(true)

    await page.keyboard.press(`${mod}+Alt+ArrowRight`)
    await expect.poll(() => isDim(first), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => isDim(second), { timeout: 10_000 }).toBe(true)
  })

  test("mod+w collapses a 2-pane split back to one pane", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await expect(visiblePaneContents(page)).toHaveCount(2)

    await page.keyboard.press(`${await modKey(page)}+w`)

    await expect
      .poll(async () => visiblePaneContents(page).count(), { timeout: 10_000 })
      .toBe(1)
    // The workbench never goes fully empty from a 2-pane state via a single
    // mod+w (content is preserved per `destroyContent:false`, or the closed
    // surface remains reachable as a background switcher tab either way).
    await expect(page.locator("[data-claxedo]")).toBeVisible()
  })

  test("mod+\\ splits the focused pane by revealing the MRU hidden surface", async ({ page }) => {
    // The reducer rejects a split whose content already fills the target pane, so the
    // chord has to feed it the most-recent hidden surface to do anything at all.
    await buildDraftPlusTerminalSplit(page)
    // Collapse to one visible pane while keeping two background surfaces, so the chord
    // has an MRU hidden surface to reveal.
    await startTerminalFromCreator(page, "codex")
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(1, { timeout: 10_000 })

    await page.keyboard.press(`${await modKey(page)}+\\`)
    await expect
      .poll(async () => visiblePaneContents(page).count(), { timeout: 10_000 })
      .toBe(2)
    await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
  })

  test("mod+tab / mod+shift+tab cycle focus by most-recently-used order", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    // Collapse to a single pane holding a 3rd surface so mod+tab has an
    // unambiguous MRU pair to toggle between the two BACKGROUND tabs left over
    // from the split.
    await startTerminalFromCreator(page, "codex")
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(1)

    const activeTitle = async () => activeTitleButton(page).getAttribute("aria-label")
    const firstActive = await activeTitle()
    const mod = await modKey(page)

    await page.keyboard.press(`${mod}+Tab`)
    await expect.poll(activeTitle, { timeout: 10_000 }).not.toBe(firstActive)
    const secondActive = await activeTitle()

    await page.keyboard.press(`${mod}+Shift+Tab`)
    await expect.poll(activeTitle, { timeout: 10_000 }).not.toBe(secondActive)
  })

  test("mod+<N> remains browser-owned instead of switching tabs", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await startTerminalFromCreator(page, "codex")
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    // Numbered surface commands are a desktop-only contract. Browsers own
    // mod+number, so the web command catalog neither advertises nor handles it.
    const tabs = switcherTabs(page)
    const count = await tabs.count()
    const labels: string[] = []
    for (let i = 0; i < count; i++) {
      labels.push((await tabs.nth(i).locator('[data-testid="switcher-title-button"]').getAttribute("aria-label")) ?? "")
    }
    // A switcher click paints `aria-current` synchronously but commits the navigation —
    // and `contentRecency` — after a 48ms debounce, so polling the attribute can see the
    // paint before the commit and a chord fired in that window gets clobbered by it.
    // Wait out the debounce before treating the click as settled.
    await tabs.nth(0).locator('[data-testid="switcher-title-button"]').click()
    await expect.poll(() => activeTitleButton(page).getAttribute("aria-label"), { timeout: 10_000 }).toBe(labels[0])
    await page.waitForTimeout(200)

    await page.keyboard.press(`${await modKey(page)}+2`)
    await expect
      .poll(() => activeTitleButton(page).getAttribute("aria-label"), { timeout: 10_000 })
      .toBe(labels[0])
  })

  test("the switcher tab strip preserves stable creation order across focus changes", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await startTerminalFromCreator(page, "codex")
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    const orderOf = async () => {
      const buttons = page.locator('[data-testid="switcher-title-button"]')
      const n = await buttons.count()
      const out: string[] = []
      for (let i = 0; i < n; i++) out.push((await buttons.nth(i).getAttribute("aria-label")) ?? "")
      return out
    }
    const before = await orderOf()

    const buttons = page.locator('[data-testid="switcher-title-button"]')
    await buttons.nth(0).click()
    await buttons.nth(1).click()
    await buttons.nth(2).click()

    const after = await orderOf()
    expect(after).toEqual(before)
  })

  test("a busy background session shows working/done dots and plays its Settings sound on session.idle", async ({ page }) => {
    await installMockAudioPlayback(page)
    const { mock, sessionDotStatus } = await establishBackgroundedSession(page, selectAgentCompletionSound)

    // Configure the sound through the real user-facing Settings control. The
    // selection preview is a positive control that the Audio seam is live;
    // reset it before driving completion so only the lifecycle playback counts.
    await expect.poll(() => audioPlayCount(page), { timeout: 5_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(150)
    await page.evaluate(() => {
      ;(window as typeof window & { __audioPlayCount__?: number }).__audioPlayCount__ = 0
    })

    // The tab does not reliably start dotless: the establishing turn's settle races the
    // click that backgrounds it and often arms a "done" badge first. The assertions below
    // are therefore state changes away from whatever badge is there, not "a dot appeared".

    mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } })
    await expect.poll(sessionDotStatus, { timeout: 15_000 }).toBe("working")
    // Only the busy tab carries a dot. The other (focused) tab is an unsent
    // draft whose `sessionId` is the `"new"` sentinel, which
    // `surfaceStatusForMeta` short-circuits to "idle" — that is what separates a
    // per-surface status from a global "something is busy" indicator.
    await expect(page.locator('[data-testid="compact-switcher-tab"] [data-switcher-status]')).toHaveCount(1)

    // The runtime's canonical completion boundary is session.idle. It must both
    // normalize the cached status to idle (working -> done dot) and trigger one
    // completion sound for this enabled, backgrounded session.
    mock.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })
    await expect.poll(sessionDotStatus, { timeout: 15_000 }).toBe("done")
    await expect.poll(() => audioPlayCount(page), { timeout: 15_000 }).toBe(1)
  })

  test("a background tab's done badge disappears once that tab is focused", async ({ page }) => {
    const { mock, sessionTab, sessionDotStatus } = await establishBackgroundedSession(page)

    // Drive a busy -> idle turn entirely while the tab is unfocused, arming the
    // unseen-done badge (`nextUnseenDone`'s `previousActive && !active` branch).
    mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } })
    await expect.poll(sessionDotStatus, { timeout: 15_000 }).toBe("working")
    mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } })
    await expect.poll(sessionDotStatus, { timeout: 15_000 }).toBe("done")

    // Focusing the tab clears the entry, `sessionSurfaceStatus` falls through to idle, and
    // `StatusDot` renders nothing: the dot leaves the DOM and the identity label takes its
    // place, rather than the dot merely changing colour.
    const titleButton = sessionTab.locator('[data-testid="switcher-title-button"]')
    await titleButton.click()
    await expect(titleButton).toHaveAttribute("aria-current", "page", { timeout: 10_000 })
    // Absence is asserted by element count, not by the status reader: `getAttribute`
    // waits on an element that is now gone and would hang to the test timeout.
    await expect(sessionTab.locator("[data-switcher-status]")).toHaveCount(0, { timeout: 15_000 })
    await expect(sessionTab.locator('[data-testid="switcher-title"]')).toHaveCount(1)
  })

  test("switching away from a split and back restores it via the saved snapshot", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await expect(visiblePaneContents(page)).toHaveCount(2)

    // Navigating to a third surface collapses to a single pane and snapshots both A and B.
    await startTerminalFromCreator(page, "codex")
    await expect(visiblePaneContents(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    const draftTitle = page.locator('[data-testid="switcher-title-button"]', { hasText: "New Session" }).first()
    await draftTitle.click()

    await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })
    // Both assertions are scoped to slots that still hold a pane: the third terminal stays
    // mounted as a background tab, so a bare terminal locator matches two nodes and dies on
    // strict mode. One paned terminal plus one paned draft is also the stronger claim —
    // the restored split holds those two surfaces and nothing else.
    const panedDraft = page.locator('[data-workbench-content][data-pane-id] [data-testid="session-content"][data-session-id="new"]')
    const panedTerminal = page.locator('[data-workbench-content][data-pane-id] [data-testid="terminal-pane"]')
    await expect(panedDraft).toHaveCount(1, { timeout: 10_000 })
    await expect(panedTerminal).toHaveCount(1, { timeout: 10_000 })
    await expect(panedDraft).toBeVisible()
    await expect(panedTerminal).toBeVisible()
  })

  test("empty workbench auto-opens a draft, and closing it suppresses the immediate re-open", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPtyMock(page)
    await openWorkbench(page, DIR)
    await unpinSidebarForSwitcher(page)

    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })
    await expect(switcherTabs(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(page.locator("[data-workbench-content]")).toHaveCount(1)

    // Close the sole draft via its own switcher-tab X (revealed on hover).
    const draftTitle = await activeTitleButton(page).getAttribute("aria-label")
    const tab = page.locator('[data-testid="compact-switcher-tab"]').filter({
      has: page.locator(`[data-testid="switcher-title-button"][aria-label="${draftTitle}"]`),
    })
    await tab.hover()
    await tab.getByRole("button", { name: `Close ${draftTitle}`, exact: true }).click()

    // The empty state has to hold across the ~2s suppression window, not be replaced by a
    // fresh draft pane after ~100ms. Sampling runs in-page because Playwright round-trips
    // are too coarse to catch a replacement that brief.
    const held = await page.evaluate(async () => {
      const paneCounts: number[] = []
      const emptyCounts: number[] = []
      for (let i = 0; i < 40; i++) {
        paneCounts.push(document.querySelectorAll("[data-workbench-content]").length)
        emptyCounts.push(document.querySelectorAll('[data-testid="empty"]').length)
        await new Promise((r) => setTimeout(r, 40))
      }
      return {
        maxPanes: Math.max(...paneCounts),
        minEmpty: Math.min(...emptyCounts),
      }
    })
    expect(held.maxPanes).toBe(0)
    expect(held.minEmpty).toBeGreaterThan(0)
  })

  test("header buttons create the corresponding surface", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPtyMock(page)
    await openWorkbench(page, DIR)
    await unpinSidebarForSwitcher(page)
    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })

    // Read the terminal bound to a pane: the first stays mounted as a background tab once
    // the second replaces it, so a bare terminal locator matches two nodes and dies on
    // strict mode. The paned scope also makes the second click a change of terminal id
    // rather than "some terminal is on screen".
    const activeTerminal = page.locator('[data-workbench-content][data-pane-id] [data-testid="terminal-pane"]')
    await startTerminalFromCreator(page, "claude")
    await expect(activeTerminal).toHaveCount(1, { timeout: 20_000 })
    await expect(activeTerminal).toBeVisible()
    const claudeTerminalId = await activeTerminal.getAttribute("data-terminal-id")

    await startTerminalFromCreator(page, "codex")
    await expect(activeTerminal).toHaveCount(1, { timeout: 20_000 })
    await expect
      .poll(() => activeTerminal.getAttribute("data-terminal-id"), { timeout: 20_000 })
      .not.toBe(claudeTerminalId)
    await expect(activeTerminal).toBeVisible()
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
    await expect(page.locator('[data-workbench-content][data-pane-id] [data-testid="session-content"][data-session-id="new"]'))
      .toBeVisible({ timeout: 10_000 })
  })

  test("mod+shift+p opens the command palette and dispatches a selected command", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await openWorkbench(page, DIR)
    await expect(page.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible({ timeout: 20_000 })

    await page.keyboard.press(`${await modKey(page)}+Shift+P`)
    const palette = page.locator('[data-testid="command-palette"]')
    await expect(palette).toBeVisible({ timeout: 10_000 })
    // `TextField` does not forward `data-slot` onto the rendered `<input>`, so the search
    // field is reached through its ancestor slot rather than the name `list.tsx` passes in.
    await palette.locator('[data-slot="list-search"] input').fill("Toggle Sidebar", { timeout: 8000 })
    const item = palette.locator('[data-slot="list-item"]', { hasText: "Toggle Sidebar" }).first()
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.click()

    await expect(palette).toHaveCount(0, { timeout: 10_000 })
    // Collapsing the rail flips `data-open`/`data-pinned` and zeroes the inline width, but
    // never unmounts the `<nav>`. Its permanent 1px right border leaves a non-empty box and
    // Playwright's visibility check ignores opacity, so a collapsed rail still reads as
    // visible; `data-open` is the unambiguous signal.
    const nav = page.getByRole("navigation", { name: "Projects and sessions" })
    await expect(nav).toHaveAttribute("data-open", "false", { timeout: 10_000 })
    await expect(nav).toHaveCSS("opacity", "0", { timeout: 10_000 })
  })

  test("mod+b toggles the sidebar", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await openWorkbench(page, DIR)
    const nav = page.getByRole("navigation", { name: "Projects and sessions" })
    await expect(nav).toBeVisible({ timeout: 20_000 })
    const mod = await modKey(page)

    // The toggle zeroes the rail's inline width and opacity without unmounting the `<nav>`.
    // Its permanent 1px right border keeps the bounding box non-empty and Playwright's
    // visibility check ignores opacity, so `not.toBeVisible()` never resolves; `data-open`
    // plus computed opacity are the collapse signals.
    const navWidth = () => nav.evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)

    await page.keyboard.press(`${mod}+b`)
    await expect(nav).toHaveAttribute("data-open", "false", { timeout: 10_000 })
    await expect(nav).toHaveCSS("opacity", "0", { timeout: 10_000 })
    await expect(nav).toHaveCount(1)
    await expect.poll(navWidth, { timeout: 10_000 }).toBe(0)

    // Re-expansion is asserted on the same signals inverted, since a one-way toggle would
    // satisfy `toBeVisible()` in both states.
    await page.keyboard.press(`${mod}+b`)
    await expect(nav).toHaveAttribute("data-open", "true", { timeout: 10_000 })
    await expect(nav).toHaveCSS("opacity", "1", { timeout: 10_000 })
    await expect.poll(navWidth, { timeout: 10_000 }).toBeGreaterThan(0)
  })

  test("two panes on the same relay-backed workspace share one ref-counted connection", async ({ page }) => {
    const WORKSPACE_ID = "ws_core_panes_split_tabs"
    const RELAY_ORIGIN = "https://relay.core-panes-split-tabs.test"
    const CLOUD_DIR = "/tmp/e2e-core-panes-split-tabs-cloud"

    const mock = await installMockRuntime(page, {
      dir: CLOUD_DIR,
      sessionId: `${SESSION_ID}_cloud`,
      cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN },
    })
    void mock

    // Enrich bootstrap/project with the `workspaces` map so
    // `signedWorkspaceFromProjects` resolves this directory to a relay-backed
    // (cloud) workspaceId instead of "local". Registered AFTER
    // installMockRuntime so it wins: Playwright matches the last-registered
    // handler first.
    const projectPayload = [
      {
        id: "proj_core_panes_split_tabs_cloud",
        worktree: CLOUD_DIR,
        name: "core-panes-split-tabs-cloud",
        time: { created: Date.now(), updated: Date.now() },
        workspaces: {
          [WORKSPACE_ID]: { id: WORKSPACE_ID, workspaceId: WORKSPACE_ID, kind: "cloud", directory: CLOUD_DIR },
        },
      },
    ]
    await page.route("**/api/claxedo/bootstrap**", async (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          healthy: true,
          events: { hostAggregate: true },
          deployment: bootstrapDeployment(),
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: CLOUD_DIR, directory: CLOUD_DIR, home: "/tmp" },
          project: projectPayload,
          provider: { all: [{ id: "opencode", name: "opencode", env: [], models: {} }], default: {}, connected: ["opencode"] },
          provider_auth: {},
          config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
        }),
      })
    })
    await page.route("**/project**", async (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projectPayload) })
    })
    // The mock's own cloud resolve only answers a query that NAMES
    // `WORKSPACE_ID`; the app asks by `directory`, so the request falls through
    // to the local default, which echoes that directory back as a `kind:
    // "local"` workspace id and contradicts the cloud inventory registered
    // above. The app stamps the resolve result into the route key, so
    // `activeDirectory` (which new terminals and sessions inherit as their
    // directory) becomes `CLOUD_DIR` instead of the relay-backed
    // `WORKSPACE_ID`, and a secondary surface then resolves local and never
    // joins the shared connection. In production the resolve endpoint returns
    // the SAME cloud id the inventory carries; mirror that fidelity so the
    // route key agrees with the inventory.
    await page.route(workspaceResolveRoute, async (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workspaceId: WORKSPACE_ID, directory: CLOUD_DIR, kind: "cloud", status: "ready" }),
      })
    })
    // One mint per shared connection: every extra pane or tab on this workspace reuses the
    // connection the first one established, so this counter never moves past 1.
    let connectionMints = 0
    await page.route(`**/api/workspace/${WORKSPACE_ID}/connection**`, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/connection")) connectionMints += 1
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          backing: "cloud-vm",
          sessionAuthority: "managed-private",
          workspaceId: WORKSPACE_ID,
          relayUrl: RELAY_ORIGIN,
          runtimeAccessToken: "test-runtime-access-token",
          tokenExpiresAt: Date.now() + 5 * 60_000,
          role: "owner",
        }),
      })
    })
    await installPtyMock(page)

    await seedOneProject(page, CLOUD_DIR)
    await openWorkbench(page, CLOUD_DIR)
    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })
    await unpinSidebarForSwitcher(page)

    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            return hook?.snapshot?.()?.[wsId]?.refs ?? null
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "workspace connection never reached refs=1 for the first pane" },
      )
      .toBe(1)

    await startTerminalFromCreator(page, "claude")
    await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
    await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })
    const draftTab = backgroundTitleButtons(page).first()
    const terminalContent = page
      .locator('[data-workbench-content][data-pane-id]')
      .filter({ has: page.locator('[data-testid="terminal-pane"]') })
    await dragTabOntoRightEdge(page, draftTab, terminalContent)
    await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })

    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            return hook?.snapshot?.()?.[wsId]?.refs ?? null
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "the second pane must not open a second workspace connection" },
      )
      .toBe(1)
    expect(connectionMints, "the second pane re-minted the workspace connection instead of sharing it").toBe(1)

    // A third surface still shares the one lease. Opening it collapses the split into a
    // single new pane while both previous panes' content survives as unpaned background
    // tabs (`destroyContent:false`), so three live `WorkspaceGate`s sit over one connection.
    await startTerminalFromCreator(page, "codex")
    await expect(visiblePaneContents(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(backgroundTitleButtons(page)).toHaveCount(2, { timeout: 10_000 })
    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            const snapshot = hook?.snapshot?.() ?? {}
            return { refs: snapshot[wsId]?.refs ?? null, workspaces: Object.keys(snapshot).length }
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "the third surface must not open a second workspace connection" },
      )
      .toEqual({ refs: 1, workspaces: 1 })
    expect(connectionMints, "the third surface re-minted the workspace connection instead of sharing it").toBe(1)

    // Closing one surface does not disturb the lease either: the workspace is
    // still open, so the connection every remaining surface reads stays the same
    // live one — no teardown, no reconnect flash, no re-mint.
    const backgroundTabRow = switcherTabs(page)
      .filter({ has: page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])') })
      .first()
    await backgroundTabRow.locator('button[aria-label^="Close "]').click()
    await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })
    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as {
              __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number; status?: string }> }
            }).__claxedoConnections
            const entry = hook?.snapshot?.()?.[wsId]
            return { refs: entry?.refs ?? null, status: entry?.status ?? null }
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "closing one surface tore down the shared workspace connection" },
      )
      .toEqual({ refs: 1, status: "ready" })
    expect(connectionMints, "closing one surface re-minted the shared workspace connection").toBe(1)
  })
})
