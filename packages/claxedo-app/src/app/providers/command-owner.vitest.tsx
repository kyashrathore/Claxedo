import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { cleanup, render } from "@solidjs/testing-library"

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ active: undefined, show: () => undefined, clear: () => undefined }),
}))
vi.mock("@/platform/settings/provider", () => ({
  useSettings: () => ({ keybinds: { get: () => undefined } }),
}))
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

import { CommandProvider, useCommand, type CommandOwner } from "./command-palette"

let command: ReturnType<typeof useCommand>

function Pane(props: { name: string; owner: CommandOwner; built: () => void }) {
  command = useCommand()
  command.register(
    "session",
    () => {
      props.built()
      return [{ id: `${props.name}.only`, title: props.name, onSelect: () => undefined }]
    },
    { owner: props.owner },
  )
  return null
}

afterEach(cleanup)

describe("command ownership in the registry", () => {
  test("two panes hold `session`; the shown, focused one serves and the other never builds its set", async () => {
    const [focused, setFocused] = createSignal("a")
    const owner = (name: string): CommandOwner => ({ isVisible: () => true, isFocused: () => focused() === name })
    const builtA = vi.fn()
    const builtB = vi.fn()

    render(() => (
      <CommandProvider>
        <Pane name="a" owner={owner("a")} built={builtA} />
        <Pane name="b" owner={owner("b")} built={builtB} />
      </CommandProvider>
    ))
    await Promise.resolve()

    expect(command.has("a.only")).toBe(true)
    expect(command.has("b.only")).toBe(false)
    expect(builtB).not.toHaveBeenCalled()

    setFocused("b")
    await Promise.resolve()
    expect(command.has("a.only")).toBe(false)
    expect(command.has("b.only")).toBe(true)
  })

  test("a retained hidden tab in the focused pane serves nothing", async () => {
    const [visible, setVisible] = createSignal(false)
    const built = vi.fn()
    render(() => (
      <CommandProvider>
        <Pane name="hidden" owner={{ isVisible: visible, isFocused: () => true }} built={built} />
      </CommandProvider>
    ))
    await Promise.resolve()
    expect(command.has("hidden.only")).toBe(false)
    expect(built).not.toHaveBeenCalled()

    setVisible(true)
    await Promise.resolve()
    expect(command.has("hidden.only")).toBe(true)
  })
})
