import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { createEffect, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ClaxedoSessionReview, type SessionReviewComment } from "./review-session"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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
})
