import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { createEffect, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { REVIEW_ROW_HOVER_INTENT_MS } from "./review-row-hover"
import { MAX_DIFF_CHANGED_LINES } from "./review-session-logic"
import { ClaxedoSessionReview, type SessionReviewComment } from "./review-session"

// The lazy edge into @pierre/diffs' worker pool. Stubbed so the hover path's
// priming is observable without booting a shiki worker in jsdom.
const primeDiffHighlight = vi.hoisted(() => vi.fn())
vi.mock("@/ui/session-kit-loaders", () => ({
  primeDiffHighlight,
  warmDiffHighlightWorkerPool: vi.fn(),
  loadFileComponent: vi.fn(),
  loadMarkdownComponent: vi.fn(),
  prewarmMarkdownStack: vi.fn(),
  scheduleMarkdownPrewarm: vi.fn(() => () => {}),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// jsdom ships no PointerEvent constructor. The list's hover owner reads only
// the pointer position and the event target, both of which MouseEvent carries.
const pointerOver = (clientX: number, clientY: number, buttons = 0) =>
  new MouseEvent("pointerover", { bubbles: true, clientX, clientY, buttons })

/** Wait past the hover-intent dwell, then let the resulting work settle. */
const rest = () => new Promise((resolve) => setTimeout(resolve, REVIEW_ROW_HOVER_INTENT_MS + 20))

/** Where the pointer really is, as the document-level tracker sees it. */
const movePointerTo = (clientX: number, clientY: number) =>
  document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX, clientY }))

describe("ClaxedoSessionReview", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      setTimeout(() => callback(performance.now()), 0)
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  test("renders the owned review root and empty state", () => {
    const view = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={[]} empty={<div data-testid="empty-review" />} />
      </FileComponentProvider>
    ))

    expect(view.getByTestId("session-review-root")).toBeTruthy()
    expect(view.getByTestId("empty-review")).toBeTruthy()
  })

  test("requests content for a pinned summary diff", async () => {
    const onDiffContentRequired = vi.fn()
    render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview
          diffs={[{ file: "src/app.ts", additions: 12, deletions: 4, status: "modified" }]}
          focusedFile="src/app.ts"
          open={["src/app.ts"]}
          onDiffContentRequired={onDiffContentRequired}
        />
      </FileComponentProvider>
    ))

    await waitFor(() => expect(onDiffContentRequired).toHaveBeenCalledWith(["src/app.ts"]))
  })

  test("does not request content for a large summary diff until forced", async () => {
    const onDiffContentRequired = vi.fn()
    render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview
          diffs={[{ file: "src/big.ts", additions: 501, deletions: 0, status: "modified" }]}
          focusedFile="src/big.ts"
          open={["src/big.ts"]}
          onDiffContentRequired={onDiffContentRequired}
        />
      </FileComponentProvider>
    ))

    await Promise.resolve()
    expect(onDiffContentRequired).not.toHaveBeenCalled()
  })

  test("honors a caller-owned forced set so a remounted review keeps its large diffs rendered", async () => {
    const onDiffContentRequired = vi.fn()
    render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview
          diffs={[{ file: "src/big.ts", additions: 501, deletions: 0, status: "modified" }]}
          focusedFile="src/big.ts"
          open={["src/big.ts"]}
          forcedFiles={["src/big.ts"]}
          onDiffContentRequired={onDiffContentRequired}
        />
      </FileComponentProvider>
    ))

    // Without the retained force this diff stays behind the large-diff gate
    // (the test above); with it, content is requested on the first mount.
    await waitFor(() => expect(onDiffContentRequired).toHaveBeenCalledWith(["src/big.ts"]))
  })

  test("reports the file a user chooses to render past the large-diff limit", async () => {
    const onForcedFilesChange = vi.fn()
    const view = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview
          diffs={[{ file: "src/big.ts", additions: 501, deletions: 0, status: "modified" }]}
          focusedFile="src/big.ts"
          open={["src/big.ts"]}
          forcedFiles={[]}
          onForcedFilesChange={onForcedFilesChange}
        />
      </FileComponentProvider>
    ))

    const action = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>(
        "[data-slot='session-review-large-diff-actions'] button",
      )
      expect(button).toBeTruthy()
      return button!
    })
    action.click()

    expect(onForcedFilesChange).toHaveBeenCalledWith(["src/big.ts"])
  })

  test("a new comment identity with no per-file difference leaves the rows alone; a real comment still lands", async () => {
    // The comment store is keyed per session, so activating a sibling session
    // hands the review a brand-new comments array that says exactly the same
    // thing. That must not rebuild rows or rewrite the corpus attribute, while
    // a genuine comment for the file must still reach the diff renderer.
    const commentedLengths: number[] = []
    const Probe = (props: { commentedLines?: unknown[] }) => {
      createEffect(() => commentedLengths.push(props.commentedLines?.length ?? -1))
      return <div data-testid="diff-body" />
    }
    const diffs = [{ file: "src/app.ts", patch: "@@ -1 +1 @@\n+a", additions: 1, deletions: 0, status: "modified" as const }]
    const [comments, setComments] = createSignal<SessionReviewComment[]>([])

    const view = render(() => (
      <FileComponentProvider component={Probe}>
        <ClaxedoSessionReview diffs={diffs} open={["src/app.ts"]} comments={comments()} />
      </FileComponentProvider>
    ))

    const body = await waitFor(() => view.getByTestId("diff-body"))
    const row = view.container.querySelector("[data-review-file='src/app.ts']")
    const corpus = view.container.querySelector("[data-review-rendered-files]")!
    let corpusWrites = 0
    const observer = new MutationObserver((records) => { corpusWrites += records.length })
    observer.observe(corpus, { attributes: true, attributeFilter: ["data-review-rendered-files"] })
    commentedLengths.length = 0

    setComments([])
    await flush()

    expect(commentedLengths).toEqual([])
    expect(corpusWrites).toBe(0)
    expect(view.getByTestId("diff-body")).toBe(body)
    expect(view.container.querySelector("[data-review-file='src/app.ts']")).toBe(row)

    setComments([{ id: "c1", file: "src/app.ts", selection: { start: 1, end: 1 }, comment: "look here" }])
    await waitFor(() => expect(commentedLengths.at(-1)).toBe(1))
    observer.disconnect()
  })

  test("materializes only a window of header rows and keeps required rows mounted", async () => {
    const diffs = Array.from({ length: 75 }, (_, index) => ({
      file: `src/file-${index}.ts`,
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    }))
    const initial = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} />
      </FileComponentProvider>
    ))

    // 75 files in the model, at most a window's worth of rows in the DOM; the
    // rest is height-preserving gap.
    const rows = initial.container.querySelectorAll("[data-review-file]")
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(20)
    expect(initial.container.querySelector("[data-review-rendered-files]")?.getAttribute("data-review-total-files")).toBe("75")
    expect(initial.container.querySelector("[data-slot='session-review-window-gap']")).toBeTruthy()
    initial.unmount()

    // Expansion belongs to retained review state, but it must not make every
    // offscreen row "required" and defeat the materialization budget.
    const allOpen = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} open={diffs.map((diff) => diff.file)} />
      </FileComponentProvider>
    ))
    expect(allOpen.container.querySelectorAll("[data-review-file]").length).toBeLessThanOrEqual(20)
    expect(allOpen.container.querySelector("[data-slot='session-review-window-gap']")).toBeTruthy()
    allOpen.unmount()

    // A focused file far outside the window is required and mounts anyway,
    // without materializing the corpus between.
    const focused = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} focusedFile="src/file-74.ts" />
      </FileComponentProvider>
    ))
    expect(focused.container.querySelector("[data-review-file='src/file-74.ts']")).toBeTruthy()
    expect(focused.container.querySelectorAll("[data-review-file]").length).toBeLessThanOrEqual(21)

    // The anchor a scroll restoration targets is required the same way.
    const anchored = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} anchorFile="src/file-50.ts" />
      </FileComponentProvider>
    ))
    expect(anchored.container.querySelector("[data-review-file='src/file-50.ts']")).toBeTruthy()
    expect(anchored.container.querySelectorAll("[data-review-file]").length).toBeLessThanOrEqual(21)
  })

  test("mounts a row's hover-only controls for the hovered row, and for a focused row", async () => {
    const diffs = [
      { file: "src/a.ts", additions: 1, deletions: 1, status: "modified" as const },
      { file: "src/b.ts", additions: 2, deletions: 2, status: "modified" as const },
    ]
    const view = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} onViewFile={() => {}} />
      </FileComponentProvider>
    ))
    const controls = (file: string) =>
      view.container.querySelector(`[data-review-file='${file}'] [data-slot='session-review-row-controls']`)
    const trigger = (file: string) =>
      view.container.querySelector<HTMLElement>(`[data-review-file='${file}'] [data-slot='accordion-trigger']`)!

    // At rest the cluster is invisible and inert, so no row carries it.
    expect(controls("src/a.ts")).toBeNull()
    expect(controls("src/b.ts")).toBeNull()

    trigger("src/a.ts").dispatchEvent(pointerOver(10, 10))
    await flush()
    expect(controls("src/a.ts")).toBeTruthy()
    expect(controls("src/a.ts")!.querySelector("[data-slot='session-review-copy-button']")).toBeTruthy()
    expect(controls("src/a.ts")!.querySelector("[data-slot='session-review-view-button']")).toBeTruthy()
    expect(controls("src/b.ts")).toBeNull()

    // Keyboard reaches the cluster the same way: focusing the row's trigger
    // mounts it before the next Tab can land on the copy button.
    trigger("src/b.ts").dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
    await flush()
    expect(controls("src/b.ts")).toBeTruthy()
  })

  test("resting on a row prefetches its diff content; passing, dragging and DOM motion do not", async () => {
    const onDiffContentRequired = vi.fn()
    const diffs = [
      { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" as const },
      { file: "src/b.ts", additions: 4, deletions: 1, status: "modified" as const },
      { file: "src/loaded.ts", patch: "@@ -1 +1 @@\n+a", additions: 1, deletions: 0, status: "modified" as const },
    ]
    const view = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} onDiffContentRequired={onDiffContentRequired} />
      </FileComponentProvider>
    ))
    const trigger = (file: string) =>
      view.container.querySelector<HTMLElement>(`[data-review-file='${file}'] [data-slot='accordion-trigger']`)!
    const over = (file: string, clientX: number, clientY: number, buttons = 0) =>
      trigger(file).dispatchEvent(pointerOver(clientX, clientY, buttons))

    // The pointer rests at (10, 20); the list was mounted around it.
    movePointerTo(10, 20)
    onDiffContentRequired.mockClear()

    // Rows materializing under that resting pointer re-fire the boundary event
    // at the SAME client point. That is the DOM moving, not the user, and it
    // must not fetch — a freshly mounted list (every Files -> Review switch
    // rebuilds one) is exactly where that would break the zero-request gates.
    over("src/a.ts", 10, 20)
    await rest()
    expect(onDiffContentRequired).not.toHaveBeenCalled()

    // A pointer dragging across the list (resizing the panel) is not choosing.
    over("src/a.ts", 30, 25, 1)
    await rest()
    expect(onDiffContentRequired).not.toHaveBeenCalled()

    // A pointer that keeps moving is passing through, not resting: the dwell
    // restarts and nothing is asked for.
    over("src/a.ts", 40, 25)
    over("src/b.ts", 41, 26)
    expect(onDiffContentRequired).not.toHaveBeenCalled()

    // Coming to rest on that row is intent.
    await rest()
    expect(onDiffContentRequired).toHaveBeenCalledWith(["src/b.ts"])

    // A row whose content is already loaded is not refetched.
    onDiffContentRequired.mockClear()
    over("src/loaded.ts", 50, 60)
    await rest()
    expect(onDiffContentRequired).not.toHaveBeenCalled()
  })

  test("resting on a row primes the highlight for what pressing it would mount", async () => {
    primeDiffHighlight.mockClear()
    const [diffs, setDiffs] = createSignal([
      // Loaded, ordinary: pressing it mounts a diff.
      { file: "src/loaded.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" as const },
      // Content still to come: pressing it now shows the placeholder.
      { file: "src/pending.ts", additions: 3, deletions: 1, status: "modified" as const },
      // Past the render ceiling: pressing it shows the large-diff guard.
      {
        file: "src/huge.ts",
        patch: "@@ -1 +1 @@\n-a\n+b\n",
        additions: MAX_DIFF_CHANGED_LINES + 1,
        deletions: 0,
        status: "modified" as const,
      },
      // Media: pressing it shows a preview, not a diff.
      { file: "src/logo.png", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" as const },
    ])
    const view = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs()} />
      </FileComponentProvider>
    ))
    const over = (file: string, clientX: number, clientY: number) =>
      view.container
        .querySelector<HTMLElement>(`[data-review-file='${file}'] [data-slot='accordion-trigger']`)!
        .dispatchEvent(pointerOver(clientX, clientY))

    movePointerTo(10, 20)
    primeDiffHighlight.mockClear()

    // Loaded and renderable: primed with the very metadata the expand mounts,
    // carrying the content-derived key the worker pool caches under.
    over("src/loaded.ts", 30, 40)
    await rest()
    expect(primeDiffHighlight).toHaveBeenCalledTimes(1)
    const [style, fileDiff] = primeDiffHighlight.mock.calls[0]!
    expect(style).toBe("unified")
    expect(fileDiff.name).toBe("src/loaded.ts")
    expect(fileDiff.cacheKey).toBeTypeOf("string")

    // Priming is per content, not per hover: coming back to a row already
    // primed asks the pool for nothing new.
    primeDiffHighlight.mockClear()
    over("src/pending.ts", 31, 41)
    await rest()
    over("src/loaded.ts", 32, 42)
    await rest()
    expect(primeDiffHighlight).not.toHaveBeenCalled()

    // Nothing renderable yet: hovering an unloaded row primes nothing...
    primeDiffHighlight.mockClear()
    over("src/pending.ts", 33, 43)
    await rest()
    expect(primeDiffHighlight).not.toHaveBeenCalled()

    // ...until the content the hover asked for arrives, which is the moment
    // pressing the row would start mounting a diff.
    setDiffs((current) =>
      current.map((diff) =>
        diff.file === "src/pending.ts" ? { ...diff, patch: "@@ -1 +1 @@\n-x\n+y\n" } : diff,
      ),
    )
    await waitFor(() => expect(primeDiffHighlight).toHaveBeenCalledTimes(1))
    expect(primeDiffHighlight.mock.calls[0]![1].name).toBe("src/pending.ts")

    // A press that would show the large-diff guard or a media preview mounts
    // no diff, so there is nothing to highlight ahead of it.
    primeDiffHighlight.mockClear()
    over("src/huge.ts", 34, 44)
    await rest()
    over("src/logo.png", 35, 45)
    await rest()
    expect(primeDiffHighlight).not.toHaveBeenCalled()
  })
})
