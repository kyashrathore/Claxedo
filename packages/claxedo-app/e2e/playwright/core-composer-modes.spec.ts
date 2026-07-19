/**
 * SPEC: Composer modes — slash commands, shell mode, mentions, attachments, drafts
 *
 * PURPOSE — the composer (`src/session-client/composer/composer.tsx` +
 * `src/components/prompt-input/*`) is a single contenteditable surface that multiplexes
 * several INPUT MODES on top of one `Prompt` (an ordered array of text/file/agent/image
 * parts, see `src/context/prompt.tsx`): plain prompting, `/`-triggered commands, `!`-
 * triggered raw shell commands, `@`-triggered file/agent mentions, and file/image
 * attachments (button, paste, or drag-drop). This spec owns the composer's INPUT
 * ergonomics — the state machine that decides what a keystroke or paste does to the
 * editor and what gets dispatched — as opposed to what happens to the reply once a
 * normal prompt is sent (owned by specs 1/2/5) or how the SENT message's tool/diff parts
 * render in the timeline (owned by spec 8/10).
 *
 * STATE MODEL — local Solid store `store` in `composer.tsx`:
 *   `popover: "at" | "slash" | null` — which mention/command popover is open; opened by
 *     `editor-actions.ts#handleInput` matching `/@(\S*)$/` (mention, disabled in shell
 *     mode) or `/^\/(\S*)$/` (slash, whole-line only) against the raw text; closed by
 *     `editor-actions.ts#closePopover` on blur, selection, or Escape.
 *   `mode: "normal" | "shell"` — entered by typing `!` at cursor position 0 in normal
 *     mode, or the `prompt.mode.shell` command (`mod+shift+x`); exited by Escape (when no
 *     popover is open), Backspace on an empty shell input, the `prompt.mode.normal`
 *     command (`mod+shift+e`), or a completed/failed shell dispatch (`submit.ts#clearInput`
 *     always resets to `"normal"`; `restoreInput` on failure puts the user-facing toggle
 *     back to whatever it was at submit time). Shell mode changes the submit icon to
 *     `arrow-undo-down` (`submit-control.tsx`), the editor to monospace, the placeholder to
 *     `prompt.placeholder.shell`, and hides comment-linked context chips
 *     (`composer.tsx`'s `contextItems`/`commentCount` memos gate on `store.mode==="shell"`).
 *   `draggingType: "image" | "@mention" | null` — set by global `dragover`/`dragleave`/
 *     `drop` listeners in `attachments.ts` (registered on `document`, not the editor, so
 *     dropping anywhere on the page is caught); drives `PromptDragOverlay`.
 *   The editor's CONTENT (`Prompt`) is a parallel source of truth kept in sync with the
 *   contenteditable DOM by `editor-actions.ts#reconcile`/`handleInput`
 *   (DOM ⇄ `parsePromptEditor`/`renderPromptEditor` in `editor-serialization.ts`). Inline
 *   `file`/`agent` mentions render as `<span data-type="file"|"agent" contenteditable=false>`
 *   pills baked directly into the editor's DOM (not a separate chip list); image
 *   attachments render as a chip strip ABOVE the editor (`image-attachments.tsx`) and live
 *   in the same `Prompt` array as `type: "image"` parts.
 *   PERSISTENCE — the whole `Prompt` (text/file/agent/image parts + cursor + separate
 *   `context.items[]`) is backed by `persisted()` (`src/utils/persist.ts`, localStorage)
 *   keyed by `Persist.scoped(directory, sessionId, "prompt")` — i.e. scoped per
 *   directory+session, so a *draft* (`sessionId` undefined/`"new"`) is scoped to just the
 *   directory. This is the ONLY state that survives reload; `store.mode`/`store.popover`
 *   are in-memory only and always reset to `"normal"`/`null` on a fresh mount.
 *
 * ANATOMY —
 *   `[data-component="prompt-input"]` — the contenteditable editor div; carries
 *     `font-mono!` while `mode==="shell"`.
 *   `[data-type="agent"][data-name=…]` / `[data-type="file"][data-path=…]` — inline
 *     mention pills baked into the editor DOM (`editor-serialization.ts#createPromptPill`).
 *   `[data-slash-id=…]` — a builtin/custom command row inside the `/` popover
 *     (`slash-popover.tsx`); `@` popover rows have no stable testid, only text content
 *     (`@<agent-name>` or a file path).
 *   `[data-action="prompt-attach"]` — the attach (paperclip/plus) button; disabled outside
 *     normal mode. A hidden `<input type="file" multiple>` sibling receives the native
 *     file-picker selection.
 *   `[data-action="prompt-submit"]` — send/stop/shell-send button; `data-icon` is `"stop"`
 *     while busy, `"arrow-undo-down"` in shell mode, else `"arrow-up"` (INVARIANTS.md #4).
 *   Image attachment chips (`image-attachments.tsx`): `img[alt=<filename>]` thumbnail
 *     (only when `mime` starts with `image/`; otherwise a folder-icon fallback), a remove
 *     button `aria-label="Remove attachment"`, clicking the thumbnail opens
 *     `[data-component="image-preview"] [data-slot="image-preview-image"]`.
 *   Drop overlay (`drag-overlay.tsx`): no testid, text "Drop images, PDFs, or text files
 *     here" (file/image drag) or "Drop to @mention file" (text drag).
 *   Sent user-message highlighting (`packages/session-ui/src/components/message-part.tsx`,
 *     rendered inside `[data-slot="session-turn-message-content"]`):
 *     `<span data-highlight="agent"|"file">` wraps the substring of the message's raw text
 *     that an `agent`/`file` request-part's `source.start`/`source.end` (or
 *     `source.text.start`/`.end` for files) points at — i.e. exactly the pill's own
 *     `@name`/`@path` text, computed client-side at submit time
 *     (`build-request-parts.ts#buildRequestParts`) and rendered from the OPTIMISTIC
 *     message, before any server round-trip.
 *
 * BEHAVIORS —
 *   1. Selecting a BUILTIN command from the `/` popover (e.g. `/model`) fires it
 *      immediately and clears the editor (`editor-actions.ts#handleSlashSelect`).
 *   2. Selecting a CUSTOM command from the same popover inserts `/<trigger> ` into the
 *      editor for further editing instead of firing.
 *   3. Typing `!` at cursor 0 in normal mode enters shell mode without inserting the `!`;
 *      Backspace on an empty shell editor returns to normal mode.
 *   4. Submitting in shell mode dispatches `POST /session/:id/shell`; on success the
 *      editor clears and mode resets to `"normal"` with no toast.
 *   5. A forced shell-dispatch failure restores the EXACT text and shell mode, and shows
 *      the "Failed to send shell command" toast.
 *   6. Escape closes an open `/`/`@` popover only — mode and text are untouched (cascade
 *      step 1).
 *   7. Escape exits shell mode back to normal when no popover is open and no turn is in
 *      flight (cascade step 2).
 *   8. Escape aborts an in-flight turn when not in shell mode and no popover is open
 *      (cascade step 3). Step 4 (blur the editor) only fires on desktop+macOS
 *      (`escBlur()` in `composer.tsx`) and is out of reach of this browser-only harness —
 *      see OUT OF SCOPE.
 *   9. Shift+Enter inserts a literal newline instead of submitting.
 *   10. Typing `@` opens the mention popover listing agents first; ArrowDown/ArrowUp move
 *       the active row (wrapping); Enter inserts the active item as an inline pill.
 *   11. The sent (optimistic) user message highlights an inline agent mention as
 *       `<span data-highlight="agent">`.
 *   12. Clicking the attach button opens the native file picker; a selected supported
 *       file renders as a thumbnail chip above the editor.
 *   13. Pasting a supported file from the clipboard adds it the same way as the button.
 *   14. Dragging a file over the composer shows the drop overlay, which disappears on
 *       drag-leave without adding anything; dropping the file adds the attachment.
 *   15. Selecting an unsupported file type shows the "Unsupported attachment" toast and
 *       adds no chip.
 *   16. The chip's remove button deletes the attachment from the prompt.
 *   17. Clicking an attachment thumbnail opens the `ImagePreview` dialog for that image.
 *   18. A prompt with only image attachments (no text) is a valid, submittable turn —
 *       oracle-proven.
 *   19. Context chips linked to a code-review comment (`item.comment` truthy) are hidden
 *       while shell mode is active (`composer.tsx`'s `contextItems` memo). UNREACHABLE in
 *       this spec's scope — see the `test.fixme` below for why.
 *   20. Composer draft text, an inline pill, and an image attachment together survive a
 *       full page reload.
 *   21. A composer draft survives navigating away to a different workspace and back.
 *
 * INVARIANTS — submit-control's `data-icon`/`disabled` is the single source of truth for
 *   submittability (INVARIANTS.md #4) — this spec reads it instead of sleeping. Sends
 *   that reach a reply go through the shared oracle (`expectAssistantReplyVisible`); shell
 *   dispatch does NOT produce an assistant reply in this mock (no `driveTurn` is
 *   triggered by `POST /session/:id/shell`), so behaviors 4/5 are proven by request counts
 *   and DOM/toast state instead, per the ground rules (oracle applies to prompt sends that
 *   produce a reply).
 *   NOTE (harness scoping caveat for 4/5): both tests submit against an ALREADY-CREATED
 *   session (`openExistingSessionPrompt`), not a fresh draft. A draft's FIRST shell
 *   submission also creates the session and navigates to it
 *   (`submit-command-prompt.ts#applyCreatedSessionHandoff`, called BEFORE
 *   `dispatchShellCommand` is even awaited — see `src/session/submit/handoff.ts`'s
 *   `queueMicrotask(() => navigate(...))`), which remounts the whole `PromptInput`
 *   component and resets its in-memory `store.mode` back to `"normal"`. When that first
 *   submission then fails, `restoreInput()` (`submit.ts`) still runs and calls
 *   `setMode(userMode)`, but against the now-unmounted OLD component instance — the text
 *   restore is still visible (it flows through the directory+session-scoped persisted
 *   `Prompt` store, which any freshly-mounted composer reads reactively) but the shell-mode
 *   restore is not, because `store.mode` is NOT part of that persisted store (see STATE
 *   MODEL). This is a real, reproducible interaction between session-creation navigation
 *   and shell-mode restore, out of scope for THIS spec (session creation/navigation is
 *   `core-first-prompt-local`'s territory) but worth a product decision — see this file's
 *   returned findings.
 *
 * HARNESS NOTES — this spec fixes the harness to the mock's default (`opencode`); harness
 *   switching does not change composer-mode mechanics and is `core-harness-ownership-*`'s
 *   territory.
 *
 * OUT OF SCOPE — prompt history stacks (ArrowUp/Down), edit-sent-message
 *   (`core-turns-reload-recovery`); Stop-button/"Still working" escalation ladder, the
 *   non-Escape abort paths (`core-busy-abort-errors`); tool/diff part rendering inside a
 *   sent message (`core-timeline-rendering-scroll`, `core-harness-rendering-matrix`);
 *   model/agent/effort controls (`core-model-effort-agent-controls`); the Escape-cascade's
 *   4th step (blur), which only fires when `platform.platform==="desktop" &&
 *   platform.os==="macos"` — not reachable from a Chromium e2e harness.
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-composer-modes"
const SESSION_ID = "ses_core_composer_modes"

// The mock's default opencode model is the `big-pickle` placeholder
// (mock-runtime.ts `BIG_PICKLE`), which the reworked composer deliberately
// treats as "no model configured" and refuses to submit
// (`isSignedWorkspaceDefaultModel`, src/features/session/composer/signed-workspace-model.ts).
// Any behavior that actually DISPATCHES (a shell command or a prompt) must pin
// a concrete harness model so the composer is submit-ready — matching sibling
// specs (core-docks `establishSession`, core-session-actions `SEND_MODELS`).
// Behaviors that never dispatch (mode toggles, popovers, draft persistence,
// attachment add/remove) leave the default untouched.
const PIN_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

// A minimal valid 1x1 transparent PNG, inlined so this spec needs no fixture files.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

// NOTE: `page.addInitScript` re-runs on EVERY navigation for the page's lifetime (not
// just the first), including `page.reload()` and subsequent `page.goto()` calls. An
// unconditional `localStorage.clear()` here would wipe the persisted composer draft
// (behaviors 20/21 test exactly that survival) out from under the app on the very
// reload/navigate the test is asserting about. `window.__OPENCODE__` is a fresh JS
// realm on every navigation so it must always be reset, but the server-catalog
// localStorage seed is written idempotently (only if absent) so it seeds a clean
// profile once per test (Playwright gives each test a fresh context) without erasing
// state the app itself persists across navigations within that same test.
async function seedProjects(page: Page, dirs: string[]) {
  await page.addInitScript((worktrees: string[]) => {
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: worktrees[0],
    }
    const key = "opencode.global.dat:server"
    if (localStorage.getItem(key)) return
    localStorage.setItem(
      key,
      JSON.stringify({
        list: [],
        projects: { local: worktrees.map((d) => ({ worktree: d, expanded: true })) },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dirs)
}

async function openDraftPrompt(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const editor = page.locator('[data-component="prompt-input"]').last()
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await expect(editor).toHaveAttribute("contenteditable", "true")
  return editor
}

/** Opens the composer for an ALREADY-CREATED session (`GET /session/:id` in the mock
 * always resolves regardless of whether `POST /session` ever ran) instead of a fresh
 * draft. Shell-mode tests use this so a submission never has to create-and-navigate a
 * session first — that create/navigate handoff (`src/session/submit/handoff.ts`)
 * remounts the composer component and resets its in-memory `store.mode` to "normal"
 * regardless of what a subsequent `restoreInput()` call does, which is a confound
 * belonging to the session-creation flow (`core-first-prompt-local`'s territory), not
 * this spec's shell-mode-restore behavior. */
async function openExistingSessionPrompt(page: Page, dir: string, sessionId: string) {
  await page.goto(`/${slug(dir)}/session/${sessionId}`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const editor = page.locator('[data-component="prompt-input"]').last()
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await expect(editor).toHaveAttribute("contenteditable", "true")
  return editor
}

/** Overrides the mock's default @-mention agent catalog (which only has the "primary"
 * `build` agent, filtered OUT of @-mention options) with two selectable, non-primary
 * agents. Registered AFTER installMockRuntime so it takes precedence. */
async function overrideMentionAgents(page: Page) {
  await page.route("**/api/claxedo/agent-config/agents**", (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "reviewer", name: "reviewer" },
        { id: "tester", name: "tester" },
      ]),
    })
  })
}

function pngFile(name = "attachment.png") {
  return { name, mimeType: "image/png", buffer: Buffer.from(PNG_BASE64, "base64") }
}

function unsupportedFile(name = "mystery.dat") {
  // A null byte anywhere in the first 4096 bytes fails the text-content heuristic in
  // `files.ts#textBytes`, and the type/extension are both unrecognized, so
  // `attachmentMime` resolves to `undefined` — the "unsupported attachment" path.
  return { name, mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 0, 5, 6, 7, 0, 9]) }
}

test.describe("core composer modes @core", () => {
  test("builtin slash command fires immediately and clears the editor — behavior 1", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("/model")
    await expect(page.locator("[data-slash-id]").first()).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-slash-id="model.choose"]').click()

    await expect(page.getByRole("dialog").filter({ hasText: "Select model" })).toBeVisible({ timeout: 10_000 })
    await expect(editor).toHaveText("", { timeout: 5_000 })
  })

  test("custom slash command inserts the trigger for editing instead of firing — behavior 2", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("/buil")
    await expect(page.locator('[data-slash-id="custom.build"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-slash-id="custom.build"]').click()

    await expect.poll(() => editor.innerText(), { timeout: 5_000 }).toBe("/build ")
    // Selecting a custom command never fires a request — it only pre-fills the editor.
    await expect(page.locator("[data-slash-id]")).toHaveCount(0)
  })

  test("! enters shell mode without inserting a character; backspace-on-empty exits — behavior 3", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)
    const submit = page.locator(SELECTORS.submitControl).last()

    await editor.click()
    await page.keyboard.press("!")

    await expect(editor).toHaveText("", { timeout: 5_000 })
    await expect(editor).toHaveClass(/font-mono/)
    await expect(submit).toHaveAttribute("data-icon", "arrow-undo-down")

    await page.keyboard.press("Backspace")
    await expect(editor).not.toHaveClass(/font-mono/)
    await expect(submit).toHaveAttribute("data-icon", "arrow-up")
  })

  test("shell dispatch success clears the editor and resets to normal mode — behavior 4", async ({ page }) => {
    // Uses an EXISTING session (see openExistingSessionPrompt) so the shell submit
    // never has to create-and-navigate a session first — that create/navigate handoff
    // is a separate confound (core-first-prompt-local's territory), not this
    // behavior's shell-mode mechanics.
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    await seedProjects(page, [DIR])
    const editor = await openExistingSessionPrompt(page, DIR, SESSION_ID)
    const submit = page.locator(SELECTORS.submitControl).last()

    await editor.click()
    await page.keyboard.press("!")
    await page.keyboard.type("ls -la")
    await submit.click()

    await expect.poll(() => mock.requests.shellCount, { timeout: 10_000 }).toBe(1)
    await expect(editor).toHaveText("", { timeout: 5_000 })
    await expect(editor).not.toHaveClass(/font-mono/)
    await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(0)
  })

  test("forced shell dispatch failure restores the exact text/mode and toasts — behavior 5", async ({ page }) => {
    // Uses an EXISTING session for the same reason as behavior 4 above: a draft's
    // first shell submission creates the session and navigates immediately (before
    // the shell dispatch's own success/failure is known — see
    // `src/components/prompt-input/submit-command-prompt.ts`'s
    // `applyCreatedSessionHandoff()` call, which runs BEFORE `dispatchShellCommand` is
    // awaited), which remounts the composer and defeats mode restoration regardless of
    // what `restoreInput()` does. That is a real, separately-worth-fixing interaction
    // between session-creation navigation and shell-mode restore — see this file's
    // findings, not a mechanic of THIS behavior, which is about shell-mode restore in
    // isolation.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    await seedProjects(page, [DIR])
    const editor = await openExistingSessionPrompt(page, DIR, SESSION_ID)
    const submit = page.locator(SELECTORS.submitControl).last()

    let shellAttempts = 0
    await page.route("**/session/*/shell**", async (route) => {
      const url = new URL(route.request().url())
      if (!url.pathname.match(/^\/session\/[^/]+\/shell$/)) return route.fallback()
      shellAttempts += 1
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
    })

    await editor.click()
    await page.keyboard.press("!")
    await page.keyboard.type("git status")
    await submit.click()

    await expect.poll(() => shellAttempts, { timeout: 10_000 }).toBe(1)
    await expect(page.getByText("Failed to send shell command")).toBeVisible({ timeout: 10_000 })
    await expect(editor).toHaveText("git status", { timeout: 5_000 })
    await expect(editor).toHaveClass(/font-mono/)
    await expect(submit).toHaveAttribute("data-icon", "arrow-undo-down")
  })

  test("Escape closes an open popover without touching mode or text — behavior 6", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("/buil")
    await expect(page.locator('[data-slash-id="custom.build"]')).toBeVisible({ timeout: 10_000 })

    await page.keyboard.press("Escape")

    await expect(page.locator("[data-slash-id]")).toHaveCount(0)
    await expect(editor).toHaveText("/buil")
    await expect(editor).not.toHaveClass(/font-mono/)
  })

  test("Escape exits shell mode when no popover is open — behavior 7", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)
    const submit = page.locator(SELECTORS.submitControl).last()

    await editor.click()
    await page.keyboard.press("!")
    await expect(submit).toHaveAttribute("data-icon", "arrow-undo-down")

    await page.keyboard.press("Escape")

    await expect(submit).toHaveAttribute("data-icon", "arrow-up")
    await expect(editor).not.toHaveClass(/font-mono/)
  })

  // Behavior 8, submit-control half: confirmed real app gap, reproduced deterministically
  // across 3 isolated runs (never flaky, never masked by load) — for a FRESH DRAFT's
  // first-ever submit (this test's exact setup, `openDraftPrompt`), the submit control's
  // busy/"stop" indicator never reflects the in-flight turn once the composer swaps from
  // the "new session" widget to the real-session composer. Traced to source:
  //   - `src/pages/session/composer/session-composer-region.tsx`'s `<PromptInput>`
  //     invocation (around line 301) never passes `status`/`activeTurn` props.
  //   - `src/session-client/composer/composer.tsx:323` — `status = createMemo(() =>
  //     props.status?.() ?? idleSessionStatus)` — silently falls back to idle when the
  //     caller omits `status`, which SessionComposerRegion always does.
  //   - `src/session-client/composer/prompt-input-props.ts:48-51` — the props are
  //     documented as "Defaults to idle for embedded contexts", but
  //     SessionComposerRegion is the PRIMARY session composer, not an embedded context.
  //   - Contrast: `src/pages/session.tsx` DOES wire `status={sessionController.status}`
  //     `activeTurn={sessionController.activeTurn}` into the OTHER `<PromptInput>` call
  //     site used only for the pre-creation "new session" draft widget (around line
  //     1488) — confirming the omission on the SessionComposerRegion path is a gap, not
  //     an intentional design (the two call sites are inconsistent for no documented
  //     reason).
  // A spec-local `page.route("**/session/status", ...)` override reflecting the mocked
  // turn's real busy state was tried as a workaround (in case this was merely a
  // `mock-runtime.ts` gap in its static `/session/status` REST stub feeding
  // `session-controller.ts`'s `activeStatusPoll` reconciliation) and made no difference —
  // the route was never even hit, which is further evidence the busy signal never
  // reaches this composer instance via ANY path, not just the REST-poll path. INVARIANTS.md
  // #4 ("submit control is the single source of truth for busy") is violated for this
  // specific fresh-draft-creates-a-session transition. See this file's returned findings.
  test.fixme(
    "Escape aborts an in-flight turn when not in shell mode and no popover is open — behavior 8",
    async ({ page }) => {
      test.setTimeout(120_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, staleBusy: true })
      await seedProjects(page, [DIR])
      const editor = await openDraftPrompt(page, DIR)
      const submit = page.locator(SELECTORS.submitControl).last()

      let abortCount = 0
      await page.route("**/session/*/abort**", async (route) => {
        abortCount += 1
        await route.fulfill({ status: 204, body: "" })
      })

      await editor.click()
      await page.keyboard.type("this will stay busy forever")
      await submit.click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 20_000 }).toBe(1)
      await expect(submit).toHaveAttribute("data-icon", "stop", { timeout: 20_000 })

      await editor.click()
      await page.keyboard.press("Escape")

      await expect.poll(() => abortCount, { timeout: 20_000 }).toBe(1)
    },
  )

  test("Shift+Enter inserts a newline instead of submitting — behavior 9", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("first line")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("second line")

    const text = await editor.innerText()
    expect(text.split("\n").map((line) => line.trim())).toEqual(["first line", "second line"])
    expect(mock.requests.promptCount).toBe(0)
  })

  test("@ mention popover keyboard nav inserts a pill and the sent message reaches the payload — behavior 10", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    await overrideMentionAgents(page)
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("@")
    await expect(page.locator("button").filter({ hasText: /^@reviewer$/ })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator("button").filter({ hasText: /^@tester$/ })).toBeVisible()

    // Down then up returns to the first item — exercises both directions.
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter")

    const pill = editor.locator('[data-type="agent"][data-name="reviewer"]')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("@tester", { exact: true })).toHaveCount(0)

    // `addPart` (editor-actions.ts:175, `const gap = document.createTextNode(" ")`)
    // already inserts a single trailing space after the pill — typing a SECOND
    // leading space here would send "@reviewer  please" (double space) and never
    // match the mock's `ack 1: ...` echo.
    await page.keyboard.type("please take a look")
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.promptBodies[0]?.text).toBe("@reviewer please take a look")
    // No trailing `$` anchor: `session-turn-assistant-content`'s textContent also
    // includes the row's agent/model/timestamp footer ("Reviewer · big-pickle · 0s")
    // concatenated after the reply text, so a fully-anchored regex can never match —
    // every other passing spec in this suite either uses a plain string (substring
    // match) or a leading-anchor-only regex for this exact reason.
    await expectAssistantReplyVisible(page, /^ack 1: @reviewer please take a look/)
  })

  // Behavior 11: REAL BUG, source-verified — the sent (optimistic) user message never
  // highlights an inline agent mention because the raw-OpenCode-Part <-> chat-UIMessage-
  // Part projection pipeline in `src/shell/chat/opencode-conversation.ts` has no case for
  // `type === "agent"` parts in either direction:
  //   - `opencodePartToChatParts` (opencode-conversation.ts:217-265) has branches for
  //     "text", "reasoning", "file", "tool" only; an "agent" part falls through to the
  //     final `return []` (line 264) and is silently dropped the moment
  //     `addRegisteredConversationMessage`/`opencodeMessageToChatMessage`
  //     (opencode-conversation.ts:110-123, 204-215) projects the optimistic send's raw
  //     parts (built by `build-request-parts.ts:120-131`, which DOES construct a proper
  //     `{type:"agent", name, source:{value,start,end}}` part) into the `UIMessage` the
  //     timeline actually renders from.
  //   - The reverse mapping, `chatPartToOpencodePart` (opencode-conversation.ts:325-369),
  //     has no "agent" case either, so even a round trip through
  //     `opencodeConversationProjection` (used by `getMsgParts` in
  //     `message-timeline.tsx:428`) could never reconstruct it.
  // Consumer-side, `UserMessageDisplay`/`HighlightedText`
  // (`packages/session-ui/src/components/message-part.tsx:1201,1350-1385`) is fully wired
  // to read `props.parts.filter(p => p.type === "agent")` and render
  // `[data-highlight="agent"]` spans — the rendering half of behavior 11 is implemented
  // and correct; only the upstream part-type conversion is missing. Confirmed empirically:
  // the sent user row's `data-highlight` span never appears (element never found within
  // 15s) even though the pill inserts correctly (behavior 10) and the same mention text
  // reaches the server payload verbatim.
  test.fixme(
    "the sent (optimistic) user message highlights an inline agent mention — behavior 11 (REAL BUG: src/shell/chat/opencode-conversation.ts:217-265,325-369 has no \"agent\" case, so the part is silently dropped in the raw-Part<->UIMessage projection)",
    async ({ page }) => {
      test.setTimeout(120_000)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await overrideMentionAgents(page)
      await seedProjects(page, [DIR])
      const editor = await openDraftPrompt(page, DIR)

      await editor.click()
      await page.keyboard.type("@")
      await expect(page.locator("button").filter({ hasText: /^@reviewer$/ })).toBeVisible({ timeout: 15_000 })
      await page.keyboard.press("Enter")
      const pill = editor.locator('[data-type="agent"][data-name="reviewer"]')
      await expect(pill).toBeVisible({ timeout: 10_000 })

      await page.keyboard.type("please take a look")
      await page.locator(SELECTORS.submitControl).last().click()

      await expect(page.locator(SELECTORS.userMessageContent)).toHaveCount(1, { timeout: 15_000 })
      const highlight = page.locator(SELECTORS.userMessageContent).locator('[data-highlight="agent"]')
      await expect(highlight).toHaveText("@reviewer", { timeout: 15_000 })
    },
  )

  test("attach button adds a thumbnail, preview opens on click, and remove deletes it — behaviors 12,16,17", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    const chooserPromise = page.waitForEvent("filechooser")
    await page.locator('[data-action="prompt-attach"]').last().click()
    const chooser = await chooserPromise
    await chooser.setFiles(pngFile("attach-me.png"))

    const thumbnail = page.locator('img[alt="attach-me.png"]')
    await expect(thumbnail).toBeVisible({ timeout: 10_000 })

    await thumbnail.click()
    await expect(page.locator('[data-component="image-preview"] [data-slot="image-preview-image"]')).toHaveAttribute(
      "alt",
      "attach-me.png",
      { timeout: 10_000 },
    )
    await page.locator('[data-slot="image-preview-close"]').click()
    await expect(page.locator('[data-component="image-preview"]')).toHaveCount(0)

    await page.getByRole("button", { name: "Remove attachment" }).click()
    await expect(thumbnail).toHaveCount(0)
    await expect(editor).toBeVisible()
  })

  test("clipboard paste adds a supported attachment — behavior 13", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)
    await editor.click()

    await editor.evaluate((el, base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const file = new File([bytes], "pasted.png", { type: "image/png" })
      const dt = new DataTransfer()
      dt.items.add(file)
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
      el.dispatchEvent(event)
    }, PNG_BASE64)

    await expect(page.locator('img[alt="pasted.png"]')).toBeVisible({ timeout: 10_000 })
  })

  test("drag-over shows the drop overlay and dropping adds the attachment — behavior 14", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    await openDraftPrompt(page, DIR)

    const dropzoneLabel = page.getByText("Drop images, PDFs, or text files here")

    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array([1, 2, 3])], "dragged.png", { type: "image/png" }))
      document.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await expect(dropzoneLabel).toBeVisible({ timeout: 10_000 })

    // Leaving without dropping hides the overlay and adds nothing.
    await page.evaluate(() => {
      document.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: null }))
    })
    await expect(dropzoneLabel).toHaveCount(0)
    await expect(page.locator('img[alt="dragged.png"]')).toHaveCount(0)

    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }))
      document.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
      document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, PNG_BASE64)

    await expect(dropzoneLabel).toHaveCount(0)
    await expect(page.locator('img[alt="dropped.png"]')).toBeVisible({ timeout: 10_000 })
  })

  test("unsupported file type shows a warning toast and adds nothing — behavior 15", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    await openDraftPrompt(page, DIR)

    const chooserPromise = page.waitForEvent("filechooser")
    await page.locator('[data-action="prompt-attach"]').last().click()
    const chooser = await chooserPromise
    await chooser.setFiles(unsupportedFile())

    await expect(page.getByText("Unsupported attachment")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Only images, PDFs, or text files can be attached here.")).toBeVisible()
    await expect(page.locator("img[alt=\"mystery.dat\"]")).toHaveCount(0)
  })

  test("an image-only prompt with no text is a valid, submittable turn — behavior 18", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    await seedProjects(page, [DIR])
    await openDraftPrompt(page, DIR)
    const submit = page.locator(SELECTORS.submitControl).last()

    const chooserPromise = page.waitForEvent("filechooser")
    await page.locator('[data-action="prompt-attach"]').last().click()
    const chooser = await chooserPromise
    await chooser.setFiles(pngFile("only-image.png"))
    await expect(page.locator('img[alt="only-image.png"]')).toBeVisible({ timeout: 10_000 })

    await expect(submit).not.toBeDisabled()
    await submit.click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    // No trailing `$` anchor — see the identical note on behavior 10's test above:
    // `session-turn-assistant-content`'s textContent includes the row's trailing
    // agent/model/timestamp footer, so a fully-anchored regex never matches.
    await expectAssistantReplyVisible(page, /^ack 1: message 1/)
  })

  // Behavior 19: comment-linked context chips (`item.comment` set) are hidden while
  // `store.mode === "shell"` per `composer.tsx`'s `contextItems` memo (filters out any
  // item carrying a non-empty `.comment` when in shell mode). The ONLY way to add such an
  // item is through the file/diff line-comment UI (`tab-file.tsx`'s
  // `createLineCommentController` `onSubmit`, or `review-tab.tsx`) or the
  // `context.addSelection` command, both of which require a real code editor with an
  // active line selection — machinery this composer-focused spec does not stand up (it
  // belongs to the file/diff-viewing specs). Recorded here, not silently dropped, per the
  // plan's "keep scenario count faithful" rule.
  test.fixme(
    "comment-linked context chips are hidden while shell mode is active — behavior 19",
    async () => {
      // See composer.tsx:388-392 for the gating logic this would exercise:
      //   const contextItems = createMemo(() => {
      //     const items = prompt.context.items()
      //     if (store.mode !== "shell") return items
      //     return items.filter((item) => !item.comment?.trim())
      //   })
    },
  )

  test("draft text, an inline pill, and an image attachment survive a full reload — behavior 20", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await overrideMentionAgents(page)
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("@")
    await expect(page.locator("button").filter({ hasText: /^@reviewer$/ })).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press("Enter")
    await page.keyboard.type("remember this draft")

    const chooserPromise = page.waitForEvent("filechooser")
    await page.locator('[data-action="prompt-attach"]').last().click()
    const chooser = await chooserPromise
    await chooser.setFiles(pngFile("draft-image.png"))
    await expect(page.locator('img[alt="draft-image.png"]')).toBeVisible({ timeout: 10_000 })

    // Persistence is localStorage-backed and effect-driven. Poll for the actual
    // PERSISTED VALUE to contain the typed text (not merely that some "prompt" key
    // exists — a key can exist from the initial empty-draft mount before the latest
    // keystrokes have flushed, which would let a stale/empty value slip through).
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((k) => k.includes("prompt"))
            .some((k) => (localStorage.getItem(k) ?? "").includes("remember this draft")),
        ),
      )
      .toBe(true)

    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    const reloadedEditor = page.locator('[data-component="prompt-input"]').last()
    await expect(reloadedEditor).toBeVisible({ timeout: 30_000 })

    await expect(reloadedEditor).toContainText("remember this draft", { timeout: 30_000 })
    await expect(reloadedEditor.locator('[data-type="agent"][data-name="reviewer"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('img[alt="draft-image.png"]')).toBeVisible({ timeout: 10_000 })
  })

  test("a draft survives navigating away to a different page and back — behavior 21", async ({ page }) => {
    test.setTimeout(120_000)
    // "Different workspace" is realized here as a navigation from the draft ("new
    // session") composer scope to an existing, already-created session's own composer
    // scope in the SAME project (`Persist.scoped(dir, id, "prompt")` keys on `id`, so a
    // real session is a genuinely different draft scope) and back — this exercises a real
    // in-app route change without the two-project bootstrap/localStorage reconciliation
    // this mock does not model (see mock-runtime.ts's single-`dir` `sessionRow`/`project`
    // shape).
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])

    const editorA = await openDraftPrompt(page, DIR)
    await editorA.click()
    await page.keyboard.type("draft in the new-session composer")
    await expect(editorA).toContainText("draft in the new-session composer", { timeout: 5_000 })
    // Poll for the PERSISTED VALUE to contain the typed text, not merely that some
    // "prompt" key exists (see behavior-20's identical fix above for why).
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((k) => k.includes("prompt"))
            .some((k) => (localStorage.getItem(k) ?? "").includes("draft in the new-session composer")),
        ),
      )
      .toBe(true)

    await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const editorSession = page.locator('[data-component="prompt-input"]').last()
    await expect(editorSession).toBeVisible({ timeout: 30_000 })
    // A real session has its own, separately-scoped (and here, untouched) draft.
    await expect(editorSession).toHaveText("", { timeout: 10_000 })

    const editorAAgain = await openDraftPrompt(page, DIR)
    await expect(editorAAgain).toContainText("draft in the new-session composer", { timeout: 30_000 })
  })
})
