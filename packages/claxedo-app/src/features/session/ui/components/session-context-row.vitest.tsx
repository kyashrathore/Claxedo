import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { SessionContextRow, type ContextChip } from "./session-context-row"

afterEach(cleanup)

function chip(openPanel: ContextChip["openPanel"]): ContextChip {
  return {
    slot: "context-chip-project",
    label: "One",
    ariaLabel: "Project",
    current: "/repo",
    options: [{ value: "/repo", label: "One" }],
    onSelect: () => {},
    panel: { label: "Create project…", render: () => <div data-testid="create-panel" /> },
    openPanel,
  }
}

describe("context chip open-panel request", () => {
  test("a request already pending when the chip mounts opens it on the panel, and closing answers it", async () => {
    const [pending, setPending] = createSignal(true)
    render(() => <SessionContextRow chips={[chip({ pending, answer: () => setPending(false) })]} />)
    const panel = await screen.findByTestId("create-panel")
    expect(panel).toBeTruthy()

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await waitFor(() => expect(screen.queryByTestId("create-panel")).toBeNull())
    expect(pending()).toBe(false)
  })

  test("with nothing pending the chip stays closed", () => {
    render(() => <SessionContextRow chips={[chip({ pending: () => false, answer: () => {} })]} />)
    expect(screen.queryByTestId("create-panel")).toBeNull()
  })
})

describe("context chip panel identity", () => {
  test("a rebuilt chip descriptor does not remount the open panel", async () => {
    let renders = 0
    const [label, setLabel] = createSignal("One")
    const build = (): ContextChip => ({
      ...chip({ pending: () => true, answer: () => {} }),
      label: label(),
      panel: { label: "Create project…", render: () => { renders += 1; return <input data-testid="panel-input" /> } },
    })
    const chips = () => [build()]
    render(() => <SessionContextRow chips={chips()} />)
    const input = await screen.findByTestId<HTMLInputElement>("panel-input")
    const rendersAtMount = renders
    input.value = "typed"
    setLabel("Two")
    await new Promise((r) => setTimeout(r, 50))
    expect(renders).toBe(rendersAtMount)
    expect(screen.getByTestId<HTMLInputElement>("panel-input").value).toBe("typed")
  })
})
