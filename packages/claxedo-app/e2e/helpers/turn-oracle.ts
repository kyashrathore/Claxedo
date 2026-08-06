// The oracle. Every spec that sends a prompt proves the reply through this module —
// never through a bare `getByText`/`locator` on assistant text. See
// `e2e/INVARIANTS.md` ("The Oracle") for the doctrine this implements.
//
// Three layers, ALL required, in order:
//   (a) DOM truth      — text present in a *visible* assistant-content slot, Thinking
//                         row gone, submit control back to ready.
//   (b) Geometric truth — non-zero bounding box inside the viewport, and a hit-test
//                         (elementFromPoint) that actually resolves inside the slot.
//   (c) Visual evidence — a screenshot captured at the moment of the claim, written to
//                         test-results/evidence/<spec>/<scenario>.png for later human/AI
//                         review. The screenshot is evidence, not proof — see doctrine.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

export const SELECTORS = {
  assistantContent: '[data-slot="session-turn-assistant-content"]',
  assistantContentVisible: '[data-slot="session-turn-assistant-content"]:not([aria-hidden="true"])',
  userMessageContent: '[data-slot="session-turn-message-content"]',
  thinkingRow: '[data-slot="session-turn-thinking"]',
  submitControl: '[data-action="prompt-submit"]',
} as const

export type Evidence = {
  /** Spec basename, e.g. "core-first-prompt-local" (no directory, no .spec.ts). */
  spec: string
  /** Scenario slug, e.g. "first-send-renders-reply". Filesystem-safe. */
  scenario: string
  /** Real harness subprocesses can need longer than the mocked-lane default. */
  timeout?: number
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "scenario"
}

/** Derives {spec, scenario} from Playwright's `testInfo` when the caller omits it. */
function resolveEvidence(explicit?: Evidence): Evidence {
  if (explicit) return explicit
  const info = test.info()
  const specFile = info.file.split(/[\\/]/).pop() ?? "spec"
  const spec = specFile.replace(/\.spec\.ts$/, "")
  const scenario = slugify(info.titlePath.slice(1).join(" ") || info.title)
  return { spec, scenario }
}

function evidencePath(evidence: Evidence, repoRoot: string, suffix = "") {
  const dir = join(repoRoot, "test-results", "evidence", evidence.spec)
  mkdirSync(dir, { recursive: true })
  return join(dir, `${evidence.scenario}${suffix}.png`)
}

/**
 * appRoot: the claxedo-app package root, used to resolve the evidence directory
 * independent of process.cwd(). Every helper below defaults to
 * `process.cwd()` when omitted, which is correct when Playwright is invoked from
 * `packages/claxedo-app` (the documented/only supported invocation directory).
 */
function packageRoot() {
  return process.cwd()
}

/**
 * Layer (a): DOM truth. Locates the assistant-content slot that is NOT aria-hidden
 * and contains `text`. Returns the Locator for layers (b)/(c) to reuse — never
 * re-queries by text a second time (that would open a re-render race).
 */
async function domTruth(page: Page, text: string | RegExp, timeout = 20_000): Promise<Locator> {
  const visible = page.locator(SELECTORS.assistantContentVisible).filter({ hasText: text })
  await expect(visible.last(), `assistant reply "${text}" never appeared in a visible assistant-content slot`).toBeVisible({
    timeout,
  })
  return visible.last()
}

async function thinkingRowGone(page: Page) {
  await expect(
    page.locator(SELECTORS.thinkingRow),
    "a Thinking row is still present after the turn claims to be settled",
  ).toHaveCount(0, { timeout: 20_000 })
}

async function submitControlReady(page: Page) {
  const submit = page.locator(SELECTORS.submitControl).last()
  await expect(submit, "submit control never returned to ready (still shows the busy/stop icon)").not.toHaveAttribute(
    "data-icon",
    "stop",
    { timeout: 20_000 },
  )
}

/**
 * Layer (b): geometric truth. Scrolls the element into view, asserts a non-zero
 * bounding box inside the viewport, then hit-tests document.elementFromPoint at the
 * element's center and asserts the hit resolves *inside* an assistant-content slot.
 * This catches overlays, zero-height collapse, and off-screen rendering that
 * CSS-visibility checks (toBeVisible) miss entirely.
 */
async function geometricTruth(page: Page, locator: Locator) {
  await expect
    .poll(
      () => locator.scrollIntoViewIfNeeded().then(() => true).catch(() => false),
      {
        timeout: 20_000,
        message: "assistant reply kept detaching while the virtualized timeline tried to scroll it into view",
      },
    )
    .toBe(true)
  // Converged, not sampled once: between domTruth resolving this locator and the
  // measurement here, a live timeline can re-render the row (part updates,
  // supersession collapsing a provisional, virtualizer regrouping) — and a
  // boundingBox taken in that instant is null for an element that is fully
  // visible a frame later. Seen exactly once, on a loaded CI runner, as
  // "no bounding box (detached or display:none)" for a reply the screenshot
  // showed on screen. The poll's exit is the box existing; an element that
  // NEVER gets a box still fails with the same message, so the oracle's claim
  // is unchanged — only its tolerance for mid-measurement re-renders.
  const box = await (async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const candidate = await locator.boundingBox().catch(() => null)
      if (candidate) return candidate
      if (Date.now() > deadline) return null
      await page.waitForTimeout(250)
      await locator.scrollIntoViewIfNeeded().catch(() => {})
    }
  })()
  expect(box, "assistant reply element has no bounding box (detached or display:none)").not.toBeNull()
  if (!box) return
  expect(box.width, "assistant reply element has zero width").toBeGreaterThan(0)
  expect(box.height, "assistant reply element has zero height").toBeGreaterThan(0)

  const viewport = page.viewportSize()
  if (viewport) {
    expect(
      box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
      `assistant reply bounding box ${JSON.stringify(box)} lies outside the viewport ${JSON.stringify(viewport)}`,
    ).toBe(true)
  }

  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const hit = await page.evaluate(
    ([x, y, selector]) => {
      const el = document.elementFromPoint(x, y)
      if (!el) return { found: false, tag: null as string | null }
      const inside = el.closest(selector as string)
      return { found: !!inside, tag: el.tagName }
    },
    [cx, cy, SELECTORS.assistantContent] as const,
  )
  expect(
    hit.found,
    `hit-test at the assistant reply's center (${cx},${cy}) resolved to <${hit.tag}> outside the assistant-content slot — an overlay or mis-positioned element is covering the reply`,
  ).toBe(true)
}

/**
 * Layer (c): visual evidence. Screenshots the viewport (the element was just
 * scrolled into view by geometricTruth) to test-results/evidence/<spec>/<scenario>.png.
 * This is captured, not asserted on — a human/AI reviewer looks at it afterward per
 * the verification doctrine in e2e/INVARIANTS.md.
 */
async function captureEvidence(page: Page, evidence: Evidence) {
  const path = evidencePath(evidence, packageRoot())
  await page.screenshot({ path })
  return path
}

/**
 * The oracle. Call this — and only this — to prove an assistant reply is visible.
 * All three layers run in order; each layer's failure message explains exactly which
 * doctrine layer broke.
 */
export async function expectAssistantReplyVisible(
  page: Page,
  text: string | RegExp,
  evidence?: Evidence,
): Promise<Locator> {
  const resolved = resolveEvidence(evidence)
  const locator = await domTruth(page, text, resolved.timeout)
  await thinkingRowGone(page)
  await submitControlReady(page)
  await geometricTruth(page, locator)
  await captureEvidence(page, resolved)
  return locator
}

/**
 * Asserts the timeline has exactly `user` user-message rows and exactly `assistant`
 * assistant-content rows. For single-text-part replies (the common mocked case) one
 * assistant-content row == one assistant turn; multi-part replies render one row per
 * part group, so callers with multi-part replies should assert on a narrower locator
 * themselves instead of this generic count.
 */
export async function expectTurnCounts(page: Page, counts: { user: number; assistant: number }) {
  await expect(page.locator(SELECTORS.userMessageContent), `expected exactly ${counts.user} user row(s)`).toHaveCount(
    counts.user,
    { timeout: 20_000 },
  )
  await expect(
    page.locator(SELECTORS.assistantContent),
    `expected exactly ${counts.assistant} assistant row(s)`,
  ).toHaveCount(counts.assistant, { timeout: 20_000 })
}

/**
 * Asserts no two rendered rows (user or assistant) carry identical text — the
 * signature of a reload/reconcile duplication bug.
 */
export async function expectNoDuplicateRows(page: Page) {
  const userTexts = await page.locator(SELECTORS.userMessageContent).allTextContents()
  const assistantTexts = await page.locator(SELECTORS.assistantContent).allTextContents()
  const dupes = (label: string, values: string[]) => {
    const seen = new Map<string, number>()
    for (const value of values) {
      const key = value.trim()
      if (!key) continue
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1)
    expect(duplicated, `${label} rows contain duplicate text: ${JSON.stringify(duplicated)}`).toEqual([])
  }
  dupes("user", userTexts)
  dupes("assistant", assistantTexts)
}

/** Re-exported for specs that need the raw selectors for a narrower assertion. */
export { evidencePath as _evidencePathForTest }
