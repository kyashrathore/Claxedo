import { cleanup, render } from "@solidjs/testing-library"
import { createSignal, flush } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import type { Placement } from "@/platform/runtime/placement"
import { Can } from "./role"

afterEach(() => cleanup())

describe("<Can>", () => {
  test("reacts when the placement gains a capability", () => {
    const [placement, setPlacement] = createSignal<Placement>({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
      role: "viewer",
    })

    const view = render(() => (
      <Can do="mutate.session" on={placement()} fallback={<span data-testid="fallback">blocked</span>}>
        <span data-testid="allowed">allowed</span>
      </Can>
    ))

    expect(view.queryByTestId("allowed")).toBeNull()
    expect(view.getByTestId("fallback")).toBeTruthy()

    flush(() => setPlacement({ ...placement(), role: "editor" }))
    expect(view.queryByTestId("fallback")).toBeNull()
    expect(view.getByTestId("allowed")).toBeTruthy()
  })
})
