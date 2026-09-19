/**
 * Core session actions: rename, fork, revert/unrevert, archive/delete, and the parent/child
 * navigation a subagent (`task` tool) run creates — every mutating action available on a
 * session that already exists, short of sending a prompt.
 *
 * Facts these tests lean on that are not visible at the call site:
 *   - Rename is local-first: the mutation PATCHes `/session/{id}` and, on success, patches
 *     the per-directory session cache directly rather than waiting for a re-fetch or an SSE
 *     echo, so every reader of that query key updates in the same tick with no reload.
 *   - Fork is reachable only through the `/fork` slash command, which opens `DialogFork`;
 *     rendered user messages carry no fork button.
 *   - Revert state (`Session.revert.messageID`) is server-authoritative and reaches the
 *     client only through a `session.updated` event carrying the full `info` — there is no
 *     optimistic local patch, which is why these tests emit that event themselves after
 *     fulfilling the revert/unrevert POST.
 *   - `rolled()` is every visible user message whose id is `>=` the revert point, so
 *     reverting the first of two messages rolls back both.
 *   - Restoring a rolled-back row is a PARTIAL restore (`POST /session/{id}/revert` with the
 *     next message's id) unless that row is the most-recently-rolled-back one, in which case
 *     it is a full `POST /session/{id}/unrevert`.
 *   - The kebab menu (Rename / Archive / Delete) is gated on `!parentID()`, so a child
 *     session has none at all. Its trigger needs an exact-name match: the sidebar renders
 *     its own "More options for <label>" buttons, which otherwise collide with
 *     "More options" under Playwright strict mode.
 *   - Archive (`PATCH {time:{archived}}`) has no confirmation step; Delete opens a dialog
 *     naming the session. Both navigate away only when the current route is viewing the
 *     affected session — to the parent if one exists, else the next sibling, else a fresh
 *     draft on the same directory. Archiving does not delete the session server-side.
 *   - `h1[data-slot="session-title-child"]` renders a child session's own title with a
 *     trailing "(@agent subagent)" suffix stripped off.
 *   - A permission or question raised BY a child session surfaces on the PARENT's dock: the
 *     request lookup walks the whole descendant tree from the queried session id.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { sessionInventoryRoute } from "../helpers/contracts/session-list"
import { installMockRuntime, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-session-actions"
const PROJECT_ID = "proj_core_session_actions"
const PROJECT_NAME = "core-session-actions"
// Pinned so the assertions have a named model to match. The mock's own default model is
// already submit-ready; this is for determinism, not to unblock submit.
const SEND_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

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

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function openSession(page: Page, dir: string, sessionId: string) {
  await page.goto(`/${slug(dir)}/session/${sessionId}`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

async function sendFirstPrompt(page: Page, mock: MockRuntimeHandles, text: string) {
  await seedOneProject(page, DIR)
  await page.goto(`/${slug(DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect(page).toHaveURL(sessionUrlPattern(mock.session.id), { timeout: 20_000 })
  await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
  await expectAssistantReplyVisible(page, `ack 1: ${text}`)
  await dismissJumpToBottom(page)
}

/**
 * The turn oracle's geometric check scrolls the reply into view, which can leave the
 * timeline just short of true bottom and arm the floating "jump to bottom" button. The
 * timeline drops that button's `pointer-events-none` once it is armed, and it sits
 * directly over the composer/slash-popover area, where it intercepts later clicks.
 * Dismiss it so every action after a send starts fully scrolled to the bottom.
 */
async function dismissJumpToBottom(page: Page) {
  // Match the semantic icon id, not a sprite href: the Codex theme draws
  // `scroll-to-latest` from an external sprite, so an href-based selector matches nothing.
  const jump = page.locator('button:has([data-icon="scroll-to-latest"])')
  if (await jump.count()) {
    await jump.first().click({ timeout: 2_000 }).catch(() => {})
  }
}

/** Captures PATCH/DELETE bodies for /session/{id} without disturbing GET handling. */
function trackSessionMutations(page: Page) {
  const patches: Array<{ id: string; body: unknown }> = []
  const deletes: string[] = []
  let failNextPatch = false
  const install = async () => {
    await page.route("**/session/*", async (route: Route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+$/.test(url.pathname)) return route.fallback()
      const method = route.request().method()
      const id = url.pathname.split("/").pop()!
      if (method === "PATCH") {
        let body: unknown
        try {
          body = route.request().postDataJSON()
        } catch {
          body = undefined
        }
        patches.push({ id, body })
        if (failNextPatch) {
          failNextPatch = false
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "failed" }) })
        }
        const title = body && typeof body === "object" && "title" in body && typeof body.title === "string"
          ? body.title
          : id
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id,
            slug: id,
            projectID: PROJECT_ID,
            directory: DIR,
            title,
            version: "2",
            time: { created: Date.now(), updated: Date.now() },
            summary: { additions: 0, deletions: 0, files: 0 },
          }),
        })
      }
      if (method === "DELETE") {
        deletes.push(id)
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id }) })
      }
      return route.fallback()
    })
  }
  return {
    install,
    patches,
    deletes,
    failNextPatch: (value: boolean) => {
      failNextPatch = value
    },
  }
}

test.describe("core session actions: rename @core", () => {
  test("double-click opens the inline editor prefilled with the current title", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "rename dblclick original title")

    const display = page.locator('h1[data-slot="session-title-child"]')
    await expect(display).toHaveText("rename dblclick original title", { timeout: 10_000 })
    await display.dblclick()

    const editor = page.locator('input[data-slot="session-title-child"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await expect(editor).toHaveValue("rename dblclick original title")
  })

  test("kebab menu Rename opens the inline editor", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "rename via kebab menu original title")

    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Rename" }).click()

    const editor = page.locator('input[data-slot="session-title-child"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await expect(editor).toHaveValue("rename via kebab menu original title")
  })

  test("Enter commits the rename via PATCH and updates the header live", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "rename enter commit original title")

    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await editor.fill("renamed via enter commit")
    await editor.press("Enter")

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const patch = mutations.patches.at(-1)!
    expect(patch.id).toBe(mock.session.id)
    expect((patch.body as { title?: string }).title).toBe("renamed via enter commit")

    const display = page.locator('h1[data-slot="session-title-child"]')
    await expect(display).toHaveText("renamed via enter commit", { timeout: 5_000 })
    await expect(page.locator('input[data-slot="session-title-child"]')).toHaveCount(0)
  })

  test("Escape cancels the edit without sending a PATCH", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "rename escape cancel original title")

    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await editor.fill("this edit should never be saved")
    await editor.press("Escape")

    await expect(page.locator('input[data-slot="session-title-child"]')).toHaveCount(0)
    await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText(
      "rename escape cancel original title",
      { timeout: 5_000 },
    )
    expect(mutations.patches.some((p) => (p.body as { title?: string } | undefined)?.title)).toBe(false)
  })

  test("a failed rename PATCH keeps the editor open and shows a toast", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "rename failed save original title")

    mutations.failNextPatch(true)
    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await editor.fill("this rename will fail")
    await editor.press("Enter")

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect(page.locator('[data-slot="toast-title"]').filter({ hasText: "Request failed" })).toBeVisible({
      timeout: 10_000,
    })
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue("this rename will fail")
  })
})

test.describe("core session actions: fork @core", () => {
  test("forking a message creates a new session and restores its draft", async ({ page }) => {
    // `resolveForkSessionId(params)` (src/features/session/ui/dialogs/fork-messages.ts)
    // returns `params.sessionId ?? params.id`, so the `/w/:workspaceId/session/:sessionId`
    // route shape populates the fork list.
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const forkedText = "fork source message please branch me"
    await sendFirstPrompt(page, mock, forkedText)

    let forkedSessionId = ""
    await page.route("**/session/*/fork**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      forkedSessionId = "ses_core_session_actions_forked"
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: forkedSessionId,
          slug: forkedSessionId,
          projectID: PROJECT_ID,
          directory: DIR,
          title: forkedText,
          version: "2",
          time: { created: Date.now(), updated: Date.now() },
          summary: { additions: 0, deletions: 0, files: 0 },
        }),
      })
    })
    // The forked session's own detail GET must resolve once the app navigates onto it.
    await page.route("**/session/*", async (route: Route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+$/.test(url.pathname)) return route.fallback()
      const id = url.pathname.split("/").pop()
      if (id !== forkedSessionId || !forkedSessionId) return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: forkedSessionId,
          slug: forkedSessionId,
          projectID: PROJECT_ID,
          directory: DIR,
          title: forkedText,
          version: "2",
          time: { created: Date.now(), updated: Date.now() },
          summary: { additions: 0, deletions: 0, files: 0 },
        }),
      })
    })
    await page.route("**/session/*/message**", async (route) => {
      const url = new URL(route.request().url())
      if (!forkedSessionId || !url.pathname.includes(forkedSessionId)) return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [], maxEventOrdinal: 0 }),
      })
    })

    // Not a role+name locator: typing "/fork" opens the slash popover, at which point the
    // composer's role flips from "textbox" to "combobox", so a `role="textbox"` locator
    // captured before the popover opens stops matching and the `Enter` selection below
    // hangs. `data-component="prompt-input"` sits on the same contenteditable node under
    // either role, so it stays valid across the popover opening.
    const input = page.locator('[data-component="prompt-input"]').last()
    await input.click()
    await input.fill("/fork")
    await expect(page.locator('button[data-slash-id="session.fork"]')).toBeVisible({ timeout: 10_000 })
    // A mouse click on the popover row is flaky here: the oracle's earlier
    // geometric-truth scroll (in sendFirstPrompt) can leave the floating "jump to
    // bottom" button re-armed directly over this row's screen coordinates (see
    // dismissJumpToBottom above), and Playwright resolves a click by the real pixel
    // under the cursor — even with `force: true` — so the click can land on that
    // overlay instead of the popover button. Select via keyboard instead (Enter with
    // the popover open and a single filtered match, exactly how a real user would
    // confirm a slash command), which routes through `selectPopoverActive()` with no
    // pointer-coordinate dependency.
    await input.press("Enter")

    await expect(page.locator('[data-slot="dialog-title"]').filter({ hasText: "Fork from message" })).toBeVisible({
      timeout: 10_000,
    })
    await page.locator('[data-slot="list-item"]').first().click()

    // Any session-route shape: the pane scope may have been upgraded to the resolved
    // workspace id by the time the fork navigates, so the directory segment is not
    // necessarily `slug(DIR)`.
    await expect(page).toHaveURL(sessionUrlPattern(forkedSessionId), { timeout: 15_000 })
    const forkedInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(forkedInput).toContainText(forkedText, { timeout: 10_000 })
  })
})

test.describe("core session actions: revert / unrevert @core", () => {
  async function sessionRowWithRevert(mock: MockRuntimeHandles, revertMessageID?: string) {
    return {
      id: mock.session.id,
      slug: mock.session.id,
      projectID: PROJECT_ID,
      directory: DIR,
      title: "revert flow first message",
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
      ...(revertMessageID ? { revert: { messageID: revertMessageID } } : {}),
    }
  }

  test("revert prefills the composer and renders the revert dock", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "revert flow first message")

    // A second turn gives the revert something to roll back: it targets the first message.
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.click()
    await input.fill("revert flow second message")
    await page.locator('[data-action="prompt-submit"]').last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
    await expectAssistantReplyVisible(page, "ack 2: revert flow second message")
    await dismissJumpToBottom(page)

    let revertedMessageID = ""
    await page.route("**/session/*/revert**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const body = route.request().postDataJSON() as { messageID?: string }
      revertedMessageID = body?.messageID ?? ""
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      mock.emit({
        type: "session.updated",
        properties: { info: await sessionRowWithRevert(mock, revertedMessageID) },
      })
    })

    // Revert the FIRST user message. `rolled()` is every visible user message whose id is
    // >= the revert point, so reverting message 1 of 2 rolls back message 1 itself too, not
    // just what follows it — two rolled-back rows here.
    const firstUserRow = page.locator('[data-component="user-message"]').first()
    await firstUserRow.hover()
    await firstUserRow.getByRole("button", { name: "Revert message" }).click()

    await expect.poll(() => revertedMessageID, { timeout: 10_000 }).not.toBe("")
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toContainText("revert flow first message", { timeout: 10_000 })

    const dock = page.locator('[data-component="session-revert-dock"]')
    await expect(dock).toBeVisible({ timeout: 10_000 })
    await expect(dock).toContainText("2 rolled back messages")

    await dock.click()
    await expect(dock.getByRole("button", { name: "Restore message" })).toHaveCount(2, { timeout: 5_000 })
  })

  test("restoring the rolled-back row fully unreverts the session", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "unrevert flow first message")

    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.click()
    await input.fill("unrevert flow second message")
    await page.locator('[data-action="prompt-submit"]').last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
    await expectAssistantReplyVisible(page, "ack 2: unrevert flow second message")
    await dismissJumpToBottom(page)

    let revertedMessageID = ""
    await page.route("**/session/*/revert**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const body = route.request().postDataJSON() as { messageID?: string }
      revertedMessageID = body?.messageID ?? ""
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      mock.emit({ type: "session.updated", properties: { info: await sessionRowWithRevert(mock, revertedMessageID) } })
    })
    let unrevertCount = 0
    await page.route("**/session/*/unrevert**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      unrevertCount += 1
      const canonical = await sessionRowWithRevert(mock, undefined)
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(canonical) })
      mock.emit({ type: "session.updated", properties: { info: canonical } })
    })

    const firstUserRow = page.locator('[data-component="user-message"]').first()
    await firstUserRow.hover()
    await firstUserRow.getByRole("button", { name: "Revert message" }).click()
    await expect.poll(() => revertedMessageID, { timeout: 10_000 }).not.toBe("")

    const dock = page.locator('[data-component="session-revert-dock"]')
    await expect(dock).toBeVisible({ timeout: 10_000 })
    await dock.click()
    // Reverting the first of two messages rolls back both (>= semantics), so the dock
    // renders two rows. Restoring is a FULL unrevert (POST /unrevert, no body) only when the
    // restored row is the most-recently-rolled-back one — here the SECOND; restoring the
    // first row would be a PARTIAL restore (POST /revert with the next message's id).
    await expect(dock.getByRole("button", { name: "Restore message" })).toHaveCount(2, { timeout: 5_000 })
    await dock.getByRole("button", { name: "Restore message" }).last().click()

    await expect.poll(() => unrevertCount, { timeout: 10_000 }).toBe(1)
    await expect(page.locator('[data-component="session-revert-dock"]')).toHaveCount(0, { timeout: 10_000 })
  })
})

test.describe("core session actions: archive / delete @core", () => {
  test("archive sends the archived timestamp and navigates away", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "archive flow original title")

    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Archive" }).click()

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const patch = mutations.patches.find((p) => (p.body as { time?: { archived?: number } } | undefined)?.time?.archived)
    expect(patch, `expected a PATCH with a time.archived timestamp, got: ${JSON.stringify(mutations.patches)}`).toBeTruthy()
    expect(patch!.id).toBe(mock.session.id)

    // Archive is not itself confirmed — no dialog appears.
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0)

    // Navigating away from the now-archived session's own route (no parent/sibling
    // to fall back to in this single-session fixture).
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).not.toContain(mock.session.id)
  })

  test("delete requires confirming a dialog naming the session, then removes it", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "delete flow original title")

    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Delete" }).click()

    await expect(page.locator('[data-slot="dialog-title"]').filter({ hasText: "Delete session" })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText('Delete session "delete flow original title"?')).toBeVisible()

    await page.getByRole("button", { name: "Delete session" }).click()

    await expect.poll(() => mutations.deletes, { timeout: 10_000 }).toContain(mock.session.id)
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).not.toContain(mock.session.id)
  })
})

test.describe("core session actions: subagent (child session) @core", () => {
  const PARENT_ID = "ses_core_session_actions_parent"
  const CHILD_ID = "ses_core_session_actions_child"
  const PARENT_TITLE = "Core session actions parent"
  const CHILD_TITLE = "Debug flaky import (@general subagent)"

  function parentRow() {
    return {
      id: PARENT_ID,
      slug: PARENT_ID,
      projectID: PROJECT_ID,
      directory: DIR,
      title: PARENT_TITLE,
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
    }
  }

  function childRow() {
    return {
      id: CHILD_ID,
      slug: CHILD_ID,
      projectID: PROJECT_ID,
      directory: DIR,
      title: CHILD_TITLE,
      parentID: PARENT_ID,
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
    }
  }

  async function installParentChildFixture(page: Page) {
    const listHandler = async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([parentRow(), childRow()]),
      })
    }
    await page.route("**/session", listHandler)
    await page.route("**/session?**", listHandler)

    await page.route("**/session/*", async (route: Route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+$/.test(url.pathname)) return route.fallback()
      if (route.request().method() !== "GET") return route.fallback()
      const id = url.pathname.split("/").pop()
      if (id === CHILD_ID) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(childRow()) })
      if (id === PARENT_ID) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(parentRow()) })
      return route.fallback()
    })

    await page.route("**/session/*/message**", async (route) => {
      const url = new URL(route.request().url())
      if (!url.pathname.includes(CHILD_ID) && !url.pathname.includes(PARENT_ID)) return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [], maxEventOrdinal: 0 }),
      })
    })
  }

  test("a directly-opened child session shows a disabled composer and breadcrumb, no kebab", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: PARENT_ID, projectId: PROJECT_ID, projectName: PROJECT_NAME })
    await installParentChildFixture(page)
    await seedOneProject(page, DIR)
    await openSession(page, DIR, CHILD_ID)

    await expect(page.getByText("Subagent sessions cannot be prompted.")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Back to main session." })).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    // Breadcrumb: parent title / stripped child title.
    await expect(page.locator('[data-slot="session-title-parent"]')).toHaveText(PARENT_TITLE, { timeout: 10_000 })
    await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText("Debug flaky import", {
      timeout: 10_000,
    })

    await expect(page.getByRole("button", { name: "More options", exact: true })).toHaveCount(0)
  })

  test("the parent breadcrumb navigates back to the parent session", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: PARENT_ID, projectId: PROJECT_ID, projectName: PROJECT_NAME })
    await installParentChildFixture(page)
    await seedOneProject(page, DIR)
    await openSession(page, DIR, CHILD_ID)

    await page.locator('[data-slot="session-title-parent"]').click()
    await expect(page).toHaveURL(sessionUrlPattern(PARENT_ID), { timeout: 15_000 })
  })

  test("a permission raised on the child bubbles into the parent's dock and resolves", async ({
    page,
  }) => {
    // The child's permission reaches the parent's dock however the workspace-id remap of
    // the event's `directory` lands: `applyDirectoryEventToShellQueries`
    // (src/features/session/data/sync/directory-event-projector.ts) runs in BOTH branches
    // of event-ingress's `children.has(directory)` check, and keys the permission-request
    // cache by `permission.sessionID` — the CHILD's id — not by directory. The mock emits a
    // production-shaped `permission.asked` over the real `/api/wr/events`
    // stream; the `replied.sessionID === CHILD_ID` assertion
    // below can only hold if the dock rendered the CHILD's permission and the Allow-once
    // POST routed to `/session/CHILD_ID/permissions/...`.

    const mock = await installMockRuntime(page, { dir: DIR, sessionId: PARENT_ID, projectId: PROJECT_ID, projectName: PROJECT_NAME })
    await installParentChildFixture(page)
    await seedOneProject(page, DIR)
    await openSession(page, DIR, PARENT_ID)
    // Wait until the parent's composer (and therefore its session-tree/request
    // queries, which key off the loaded directory session cache) is fully mounted
    // before emitting the child's permission — avoids a race against cache load.
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 15_000 })

    let replied: { sessionID: string; requestID: string } | undefined
    await page.route("**/session/*/permissions/**", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const url = new URL(route.request().url())
      const parts = url.pathname.split("/")
      const sessionID = parts[2]
      const requestID = parts[4]
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      replied = { sessionID, requestID }
      mock.emit({ type: "permission.replied", properties: { sessionID, requestID } })
    })

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_child_bash",
        sessionID: CHILD_ID,
        permission: "bash",
        patterns: ["rm -rf *"],
        metadata: {},
        always: [],
      },
    })

    await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 15_000 })
    const actions = page.locator('[data-slot="permission-footer-actions"]')
    await expect(actions.getByRole("button", { name: "Allow once" })).toBeVisible()
    await actions.getByRole("button", { name: "Allow once" }).click()

    await expect.poll(() => replied?.sessionID, { timeout: 10_000 }).toBe(CHILD_ID)
    await expect(page.locator('[data-slot="permission-header-title"]')).toHaveCount(0, { timeout: 10_000 })
  })

  test("a harness session's auto-title patches the sidebar inventory even without a resolvable projectID", async ({ page }) => {
    const HARNESS_SESSION_ID = "ses_core_session_actions_harness_title"
    await installMockRuntime(page, {
      dir: DIR,
      sessionId: HARNESS_SESSION_ID,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      harness: "acp:codex",
    })
    // The shared helper already mocks the session-inventory bootstrap endpoint
    // (`fetchLocalControlSessions`, src/features/session/data/sync/inventory-source.ts)
    // with the real route's own empty answer. This override supplies the one seeded row
    // this behavior needs, and must be registered AFTER `installMockRuntime` to win:
    // Playwright resolves routes last-registered-first.
    await page.route(sessionInventoryRoute, async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{
            sessionID: HARNESS_SESSION_ID,
            title: "New Session",
            directory: DIR,
            projectID: PROJECT_ID,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }],
        }),
      })
    })
    await seedOneProject(page, DIR)
    await openSession(page, DIR, HARNESS_SESSION_ID)
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 15_000 })

    // This assertion pins a query-cache contract — the sessionInventory row's
    // title/projectID after the fallback — with no DOM surface on this route: the visible
    // sidebar tree rows render from `/api/control/session-list`, a different source.
    // Reading `__claxedoQueryClient` is safe because it is installed unconditionally
    // (src/platform/query/query-client.ts, no `import.meta.env.DEV` guard), so it survives
    // into production bundles rather than being dead-code-eliminated.
    const inventoryRow = async () =>
      page.evaluate((sessionId: string) => {
        const qc = (window as unknown as { __claxedoQueryClient?: { getQueryCache(): { findAll(): unknown[] } } })
          .__claxedoQueryClient
        if (!qc) return undefined
        const query = qc.getQueryCache().findAll().find((item) => {
          const key = (item as { queryKey?: unknown[] }).queryKey
          return Array.isArray(key) && key.includes("sessionInventory")
        }) as { state?: { data?: { sessions?: Array<{ id?: string; title?: string; projectID?: string }> } } } | undefined
        const sessions = query?.state?.data?.sessions
        return Array.isArray(sessions) ? sessions.find((item) => item?.id === sessionId) : undefined
      }, HARNESS_SESSION_ID)

    // Bootstrap has loaded the session inventory with the original title.
    await expect.poll(async () => (await inventoryRow())?.title, { timeout: 15_000 }).toBe("New Session")

    // The harness's auto-title fallback (`maybeAutoTitle`,
    // packages/agent-sdk-runtime/src/harnesses/acp/title.ts) publishes a
    // `session.updated` event that hardcodes `projectID: ""`; combine that with a
    // `directory` that does NOT exactly match the registered project's worktree
    // (the directory-shape-routing debt) so `event-ingress.ts`'s OWN
    // `projectFor(info.directory)` backfill ALSO fails to resolve one — isolating
    // exactly the fallback path in `applySessionInventoryLifecycle`
    // (src/features/session/data/sync/inventory-writers.ts).
    //
    // DELIVERY: direct route-fulfill of EVERY subsequent `/api/wr/events` GET
    // with the same envelope, rather than one `mock.emit()`: under the prebuilt
    // production build, code-splitting shifts when the reader's chunk mounts and
    // reconnects, and a `times`-capped route can be consumed by a connection the
    // reader tears down before parsing. The frame is an idempotent same-payload
    // upsert, so re-delivery is a no-op, and the route is torn down with the
    // page context.
    const titleEnvelope = {
      directory: DIR,
      payload: {
        type: "session.updated",
        properties: {
          info: {
            id: HARNESS_SESSION_ID,
            slug: HARNESS_SESSION_ID,
            projectID: "",
            directory: `${DIR}/.codex-sandbox-mismatched-shape`,
            title: "fix the flaky retry test",
            version: "2",
            time: { created: Date.now() - 1000, updated: Date.now() },
          },
        },
      },
    }
    await page.route(
      "**/api/wr/events**",
      async (route) => {
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: `data: ${JSON.stringify(titleEnvelope)}\n\n`,
          })
          .catch(() => {})
      },
    )

    await expect.poll(async () => (await inventoryRow())?.title, { timeout: 15_000 }).toBe("fix the flaky retry test")
    // The row keeps its originally-known projectID/grouping rather than being
    // dropped from the inventory entirely.
    expect((await inventoryRow())?.projectID).toBe(PROJECT_ID)
  })
})

test.describe("core session actions: switcher tab title sync @core", () => {
  test("title syncs to the session's own switcher-strip tab label without reload", async ({ page }) => {
    // The second surface for a session's title is the compact switcher strip
    // (src/app/workbench/compact-switcher/compact-switcher.tsx) in the workbench header,
    // rendered only while the sidebar rail is unpinned — `sidebarPinned` is
    // `railRegion().docked !== false`, so collapsing the rail with the `sidebar-toggle`
    // button un-docks it and reveals the strip.
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "switcher tab title sync original title")

    const toggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()
    await expect(toggle).toHaveCount(0)

    const switcher = page.locator('[data-testid="compact-switcher"]')
    await expect(switcher).toBeVisible({ timeout: 10_000 })
    const tab = switcher.locator('[data-testid="compact-switcher-tab"]')
    await expect(tab).toHaveCount(1)
    const switcherTitle = tab.locator('[data-testid="switcher-title"]')
    await expect(switcherTitle).toHaveText("switcher tab title sync original title", { timeout: 10_000 })

    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await editor.fill("switcher tab title sync renamed")
    await editor.press("Enter")

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const patch = mutations.patches.at(-1)!
    expect(patch.id).toBe(mock.session.id)
    expect((patch.body as { title?: string }).title).toBe("switcher tab title sync renamed")

    await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText("switcher tab title sync renamed", { timeout: 5_000 })

    // The strip's tab for this same session updates live too — nothing navigates between
    // the rename and this assertion.
    await expect(switcherTitle).toHaveText("switcher tab title sync renamed", { timeout: 10_000 })
  })
})
