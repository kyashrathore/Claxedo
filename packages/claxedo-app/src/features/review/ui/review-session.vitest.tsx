import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ClaxedoSessionReview } from "./review-session"

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

  test("mounts every changed-file header progressively and includes a focused file beyond the first batch", async () => {
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

    expect(initial.container.querySelectorAll("[data-review-file]")).toHaveLength(8)
    expect(initial.container.querySelector("[data-review-rendered-files]")?.getAttribute("data-review-total-files")).toBe("75")
    await waitFor(() => expect(initial.container.querySelectorAll("[data-review-file]")).toHaveLength(75))
    initial.unmount()

    const focused = render(() => (
      <FileComponentProvider component="div">
        <ClaxedoSessionReview diffs={diffs} focusedFile="src/file-74.ts" />
      </FileComponentProvider>
    ))
    expect(focused.container.querySelectorAll("[data-review-file]")).toHaveLength(75)
  })
})
