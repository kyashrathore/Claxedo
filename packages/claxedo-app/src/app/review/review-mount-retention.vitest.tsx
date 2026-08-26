import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { createMemo, createSignal, type Accessor } from "solid-js"
import { reviewRegionPolicy } from "./review-region-policy"

afterEach(() => cleanup())

function ReviewRegionHarness(props: {
  regionKey: Accessor<string | undefined>
  ready: Accessor<boolean>
  onSettled: () => void
}) {
  const reviewArmed = createMemo((prev: ReturnType<typeof reviewRegionPolicy> | undefined) =>
    reviewRegionPolicy({
      key: props.regionKey(),
      prev,
      ready: props.ready(),
    }),
  )

  const ReviewBody = () => {
    props.onSettled()
    return <div data-testid="review-body" />
  }

  return (
    <div class="relative">
      {reviewArmed().armed ? (
        <div data-testid="review-shell" style={{ visibility: props.ready() ? "visible" : "hidden" }}>
          <ReviewBody />
        </div>
      ) : null}
      {reviewArmed().showPending ? <div data-testid="workspace-review-pending" /> : null}
    </div>
  )
}

describe("review region mount retention", () => {
  test("workspace reconnects show pending chrome without remounting review content", async () => {
    const [ready, setReady] = createSignal(false)
    const [regionKey] = createSignal<string | undefined>("ws\nreview")
    let mounts = 0
    const view = render(() => (
      <ReviewRegionHarness regionKey={regionKey} ready={ready} onSettled={() => (mounts += 1)} />
    ))

    expect(view.queryByTestId("review-body")).toBeNull()
    expect(view.queryByTestId("workspace-review-pending")).not.toBeNull()

    setReady(true)
    await waitFor(() => expect(view.queryByTestId("review-body")).not.toBeNull())
    const body = view.getByTestId("review-body")
    expect(mounts).toBe(1)
    expect(view.queryByTestId("workspace-review-pending")).toBeNull()
    expect(view.getByTestId("review-shell").style.visibility).toBe("visible")

    setReady(false)
    await waitFor(() => expect(view.queryByTestId("workspace-review-pending")).not.toBeNull())
    expect(view.getByTestId("review-body")).toBe(body)
    expect(mounts).toBe(1)
    expect(view.getByTestId("review-shell").style.visibility).toBe("hidden")

    setReady(true)
    await waitFor(() => expect(view.queryByTestId("workspace-review-pending")).toBeNull())
    expect(view.getByTestId("review-body")).toBe(body)
    expect(mounts).toBe(1)
    expect(view.getByTestId("review-shell").style.visibility).toBe("visible")
  })

  test("changing keys gates a new review region until it is ready", async () => {
    const [ready, setReady] = createSignal(true)
    const [regionKey, setRegionKey] = createSignal<string | undefined>("ws\nreview")
    let mounts = 0
    const view = render(() => (
      <ReviewRegionHarness regionKey={regionKey} ready={ready} onSettled={() => (mounts += 1)} />
    ))

    await waitFor(() => expect(view.queryByTestId("review-body")).not.toBeNull())
    expect(mounts).toBe(1)

    setReady(false)
    setRegionKey("other\nreview")
    await waitFor(() => expect(view.queryByTestId("review-body")).toBeNull())
    expect(view.queryByTestId("workspace-review-pending")).not.toBeNull()

    setReady(true)
    await waitFor(() => expect(view.queryByTestId("review-body")).not.toBeNull())
    expect(mounts).toBe(2)
  })
})
