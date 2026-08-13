import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createResource, createMemo, type Accessor, type Resource } from "solid-js"
import { SessionComposerLoadBoundary } from "@/features/session/ui/session-progressive-surfaces"
import { readWithoutSuspending } from "./suspense-safe-resource"

afterEach(() => cleanup())

const FALLBACK = '[data-component="session-prompt-dock-loading"]'
const never = () => new Promise<string[]>(() => {})

/**
 * Mirrors the real readers: the accessor is read inside a TRACKED MEMO
 * (`ui/popover-controller.ts:44`, `v2/controller-engine.ts:80`), which is where
 * the suspension is armed — not directly in JSX.
 */
function SlashCommandMemo(props: { read: () => string[] | undefined }) {
  const commands = createMemo(() => (props.read() ?? []).join(","))
  return <div data-testid="composer">{commands()}</div>
}

function mount(read: (resource: Resource<string[]>) => () => string[] | undefined, fetcher = never) {
  let resource!: Resource<string[]>
  return render(() => {
    const [r] = createResource(fetcher)
    resource = r
    return (
      <SessionComposerLoadBoundary>
        <SlashCommandMemo read={read(resource)} />
      </SessionComposerLoadBoundary>
    )
  })
}

describe("readWithoutSuspending under SessionComposerLoadBoundary", () => {
  test("THE DEFECT: an unguarded read of a pending resource re-suspends the boundary", () => {
    const view = mount((resource) => () => resource())
    expect(view.container.querySelector(FALLBACK)).not.toBeNull()
    expect(view.queryByTestId("composer")).toBeNull()
  })

  test("THE FIX: the guarded read leaves the composer mounted while the list loads", () => {
    const view = mount((resource) => () => readWithoutSuspending(resource))
    expect(view.container.querySelector(FALLBACK)).toBeNull()
    expect(view.queryByTestId("composer")).not.toBeNull()
    // Semantic consequence, asserted rather than assumed: no custom commands yet.
    expect(view.getByTestId("composer").textContent).toBe("")
  })

  test("a resolved resource reads through the guard unchanged", async () => {
    const view = mount(
      (resource) => () => readWithoutSuspending(resource),
      async () => ["deploy", "ship"],
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(view.container.querySelector(FALLBACK)).toBeNull()
    expect(view.getByTestId("composer").textContent).toBe("deploy,ship")
  })

  test("a plain non-resource accessor is read unchanged", () => {
    const plain: Accessor<string[] | undefined> = () => ["built-in"]
    expect(readWithoutSuspending(plain)).toEqual(["built-in"])
  })
})
