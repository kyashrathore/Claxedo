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
 *   `[data-action="prompt-add"]` — the `+` trigger; opens the FLAT action menu
 *     (`add-menu.tsx`: "Images and files" ⌘U / "Commands" / / "Context" @ / "Shell
 *     command" !) and is `disabled` outside normal mode / while `harnessPending()`.
 *   `[data-action="prompt-commands"]` / `[data-action="prompt-context"]` — the menu items
 *     that open the `/` and `@` popovers on an EMPTY query without typing a trigger
 *     character (`editor-actions.ts#openPopover`).
 *   `[data-action="prompt-attach"]` — "Images and files", the menu ITEM inside that menu
 *     that opens the native file chooser (it is no longer the `+` button itself). A hidden
 *     `<input type="file" multiple>` sibling receives the file-picker selection. Use
 *     `openAttachPicker()` below rather than clicking it directly.
 *   `[data-action="prompt-submit"]` — send/stop/shell-send button; `data-icon` is `"stop"`
 *     while busy, `"arrow-undo-down"` in shell mode, else `"send"` (INVARIANTS.md #4).
 *     `data-icon` carries the SEMANTIC icon id, which each theme maps to its own glyph
 *     (the opencode theme draws `send` as its `arrow-up` sprite) — so assert the semantic
 *     id, never the per-theme sprite name, or the assertion breaks on a theme swap.
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
 *   4/5. Retired with the OpenCode-specific `/session/:id/shell` backend route. Shell
 *      execution has no generic AgentRuntime contract; this suite does not synthesize one.
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
 *       while shell mode is active (`composer.tsx`'s `contextItems` memo). NOT COVERED
 *       here: the test was deleted (not fixme'd) per e2e/e2e-decisions.md #15 — see the
 *       standing comment where it used to live, below behavior 18's test.
 *   20. Composer draft text, an inline pill, and an image attachment together survive a
 *       full page reload.
 *   21. A composer draft survives navigating away to a different workspace and back.
 *
 * INVARIANTS — submit-control's `data-icon`/`disabled` is the single source of truth for
 *   submittability (INVARIANTS.md #4) — this spec reads it instead of sleeping. Sends
 *   that reach a reply go through the shared oracle (`expectAssistantReplyVisible`).
 *
 * HARNESS NOTES — this spec fixes the harness to the mock's generic default connection; harness
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
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-composer-modes"
const SESSION_ID = "ses_core_composer_modes"

const PIN_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

// A minimal valid 1x1 transparent PNG, inlined so this spec needs no fixture files.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

// `addInitScript` re-runs on every navigation, including reload. An unconditional
// `localStorage.clear()` would wipe the persisted draft the reload tests assert on, so
// the seed is written only when absent; `__CLAXEDO__` is a fresh realm each time.
async function seedProjects(page: Page, dirs: string[]) {
  await page.addInitScript((worktrees: string[]) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: worktrees[0],
    }
    const key = "claxedo.global.dat:server"
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

/** Two selectable non-primary agents; the mock's default `build` agent is primary and
 * filtered out of @-mentions. Registered after `installMockRuntime` so it wins. */
async function overrideMentionAgents(page: Page) {
  await page.route("**/api/claxedo/agent-config/agents**", (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "reviewer", name: "reviewer", mode: "subagent" },
        { id: "tester", name: "tester", mode: "subagent" },
      ]),
    })
  })
}

function pngFile(name = "attachment.png") {
  return { name, mimeType: "image/png", buffer: Buffer.from(PNG_BASE64, "base64") }
}

function unsupportedFile(name = "mystery.dat") {
  // A null byte fails the text heuristic and the type/extension are unrecognized, so
  // `attachmentMime` resolves to undefined.
  return { name, mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 0, 5, 6, 7, 0, 9]) }
}

/** `+` opens the action menu; "Images and files" opens the native picker. The
 * filechooser listener is registered before the click so the event cannot be missed. */
async function openAttachPicker(page: Page) {
  const chooserPromise = page.waitForEvent("filechooser")
  await page.locator('[data-action="prompt-add"]').last().click()
  const attachItem = page.locator('[data-action="prompt-attach"]')
  await expect(attachItem).toBeVisible({ timeout: 10_000 })
  await attachItem.click()
  return await chooserPromise
}

test.describe("core composer modes @core", () => {
  test("builtin slash command fires immediately and clears the editor", async ({ page }) => {
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

  test("custom slash command inserts the trigger for editing instead of firing", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    await editor.click()
    await page.keyboard.type("/buil")
    await expect(page.locator('[data-slash-id="custom.build"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-slash-id="custom.build"]').click()

    await expect.poll(() => editor.innerText(), { timeout: 5_000 }).toBe("/build ")
    await expect(page.locator("[data-slash-id]")).toHaveCount(0)
  })

  test("! enters shell mode without inserting a character; backspace-on-empty exits", async ({
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
    await expect(submit).toHaveAttribute("data-icon", "send")
  })

  test("Escape closes an open popover without touching mode or text", async ({ page }) => {
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

  test("Escape exits shell mode when no popover is open", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)
    const submit = page.locator(SELECTORS.submitControl).last()

    await editor.click()
    await page.keyboard.press("!")
    await expect(submit).toHaveAttribute("data-icon", "arrow-undo-down")

    await page.keyboard.press("Escape")

    await expect(submit).toHaveAttribute("data-icon", "send")
    await expect(editor).not.toHaveClass(/font-mono/)
  })

  test(
    "Escape aborts an in-flight turn when not in shell mode and no popover is open",
    async ({ page }) => {
      test.setTimeout(120_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, holdTurn: true })
      await seedProjects(page, [DIR])
      const editor = await openDraftPrompt(page, DIR)
      const submit = page.locator(SELECTORS.submitControl).last()

      await editor.click()
      await page.keyboard.type("this will stay busy forever")
      await ensureComposerModelSelected(page)
      await submit.click()
      await expect.poll(() => mock.requests.promptCount, { timeout: 20_000 }).toBe(1)
      await expect(submit).toHaveAttribute("data-icon", "stop", { timeout: 20_000 })

      await editor.click()
      await page.keyboard.press("Escape")

      await expect.poll(() => mock.requests.abortCount, { timeout: 20_000 }).toBe(1)
    },
  )

  test("Shift+Enter inserts a newline instead of submitting", async ({ page }) => {
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

  test("@ mention popover keyboard nav inserts a pill and the sent message reaches the payload", async ({
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

    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter")

    const pill = editor.locator('[data-type="agent"][data-name="reviewer"]')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("@tester", { exact: true })).toHaveCount(0)

    // The pill already carries a trailing space; a leading space here would double it.
    await page.keyboard.type("please take a look")
    await ensureComposerModelSelected(page)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    expect(mock.requests.promptBodies[0]?.text).toBe("@reviewer please take a look")
    // No trailing anchor: the content slot's text also includes the row's footer.
    await expectAssistantReplyVisible(page, /^ack 1: @reviewer please take a look/)
  })

  test(
    "the sent (optimistic) user message highlights an inline agent mention",
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
      await ensureComposerModelSelected(page)
      await page.locator(SELECTORS.submitControl).last().click()

      await expect(page.locator(SELECTORS.userMessageContent)).toHaveCount(1, { timeout: 15_000 })
      const highlight = page.locator(SELECTORS.userMessageContent).locator('[data-highlight="agent"]')
      await expect(highlight).toHaveText("@reviewer", { timeout: 15_000 })
    },
  )

  test("attach button adds a thumbnail, preview opens on click, and remove deletes it", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    const editor = await openDraftPrompt(page, DIR)

    const chooser = await openAttachPicker(page)
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

  test("clipboard paste adds a supported attachment", async ({ page }) => {
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

  test("drag-over shows the drop overlay and dropping adds the attachment", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    await openDraftPrompt(page, DIR)

    const dropzoneLabel = page.getByText("Drop images, PDFs, or text files here")

    // The drop zone is the workbench slot the composer renders in, not the
    // document: a drop reaches the surface it lands on and no other.
    await page.evaluate(() => {
      const zone = document.querySelector('[data-component="prompt-input"]')?.closest("[data-workbench-content]")
      if (!zone) throw new Error("composer is not inside a workbench slot")
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array([1, 2, 3])], "dragged.png", { type: "image/png" }))
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await expect(dropzoneLabel).toBeVisible({ timeout: 10_000 })

    await page.evaluate(() => {
      const zone = document.querySelector('[data-component="prompt-input"]')!.closest("[data-workbench-content]")!
      zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: null }))
    })
    await expect(dropzoneLabel).toHaveCount(0)
    await expect(page.locator('img[alt="dragged.png"]')).toHaveCount(0)

    await page.evaluate((base64) => {
      const zone = document.querySelector('[data-component="prompt-input"]')!.closest("[data-workbench-content]")!
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }))
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, PNG_BASE64)

    await expect(dropzoneLabel).toHaveCount(0)
    await expect(page.locator('img[alt="dropped.png"]')).toBeVisible({ timeout: 10_000 })
  })

  test("unsupported file type shows a warning toast and adds nothing", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])
    await openDraftPrompt(page, DIR)

    const chooser = await openAttachPicker(page)
    await chooser.setFiles(unsupportedFile())

    await expect(page.getByText("Unsupported attachment")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Only images, PDFs, or text files can be attached here.")).toBeVisible()
    await expect(page.locator("img[alt=\"mystery.dat\"]")).toHaveCount(0)
  })

  test("an image-only prompt with no text is a valid, submittable turn", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    await seedProjects(page, [DIR])
    await openDraftPrompt(page, DIR)
    const submit = page.locator(SELECTORS.submitControl).last()

    const chooser = await openAttachPicker(page)
    await chooser.setFiles(pngFile("only-image.png"))
    await expect(page.locator('img[alt="only-image.png"]')).toBeVisible({ timeout: 10_000 })

    await expect(submit).not.toBeDisabled()
    await ensureComposerModelSelected(page)
    await submit.click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    // No trailing anchor: the content slot's text also includes the row's footer.
    await expectAssistantReplyVisible(page, /^ack 1: message 1/)
  })

  test("draft text, an inline pill, and an image attachment survive a full reload", async ({
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

    const chooser = await openAttachPicker(page)
    await chooser.setFiles(pngFile("draft-image.png"))
    await expect(page.locator('img[alt="draft-image.png"]')).toBeVisible({ timeout: 10_000 })

    // Poll for the persisted value itself: a "prompt" key exists from the empty-draft
    // mount before the keystrokes flush.
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

  test("draft text is scoped to its surface and does not leak into a later draft surface", async ({ page }) => {
    test.setTimeout(120_000)
    // Drafts are keyed by surface identity, so neither the session composer nor a later
    // draft may inherit the first draft's text even though all share a directory.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedProjects(page, [DIR])

    const editorA = await openDraftPrompt(page, DIR)
    await editorA.click()
    await page.keyboard.type("draft in the new-session composer")
    await expect(editorA).toContainText("draft in the new-session composer", { timeout: 5_000 })
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
    await expect(editorSession).toHaveText("", { timeout: 10_000 })

    const editorAAgain = await openDraftPrompt(page, DIR)
    await expect(editorAAgain).toHaveText("", { timeout: 30_000 })
  })
})
