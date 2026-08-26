import { Suspense, createResource, type ParentProps } from "solid-js"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@opencode-ai/ui/toast", () => ({
  Toast: { Region: () => <div data-testid="toast-region" /> },
}))

vi.mock("./workbench/state", () => ({
  ClaxedoStateProvider: (props: ParentProps) => <>{props.children}</>,
}))

vi.mock("./app-shell", () => ({
  ClaxedoAppShellInner: (props: ParentProps) => <main data-testid="app-shell-inner">{props.children}</main>,
}))

const { ClaxedoAppShell } = await import("./app-shell-bootstrap")

function PendingSurface() {
  const [value] = createResource(() => new Promise<string>(() => {}))
  return <div>{value()}</div>
}

describe("ClaxedoAppShell suspense ownership", () => {
  afterEach(cleanup)

  test("does not trap descendant suspension in a shell-wide boundary", () => {
    render(() => (
      <Suspense fallback={<div data-testid="feature-fallback">Loading feature</div>}>
        <ClaxedoAppShell>
          <PendingSurface />
        </ClaxedoAppShell>
      </Suspense>
    ))

    expect(screen.getByTestId("feature-fallback")).toBeTruthy()
    expect(screen.queryByTestId("toast-region")).toBeNull()
    expect(screen.queryByTestId("app-shell-inner")).toBeNull()
  })

  test("keeps the live shell mounted when a feature owns its loading boundary", () => {
    render(() => (
      <ClaxedoAppShell>
        <section data-testid="feature-surface">
          <Suspense fallback={<div data-testid="feature-fallback">Loading feature</div>}>
            <PendingSurface />
          </Suspense>
        </section>
      </ClaxedoAppShell>
    ))

    expect(screen.getByTestId("toast-region")).toBeTruthy()
    expect(screen.getByTestId("app-shell-inner")).toBeTruthy()
    expect(screen.getByTestId("feature-surface")).toBeTruthy()
    expect(screen.getByTestId("feature-fallback")).toBeTruthy()
  })
})
