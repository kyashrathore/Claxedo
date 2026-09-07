import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { dict as en } from "@/platform/i18n/en"

const toast = vi.hoisted(() => ({ showToast: vi.fn() }))

vi.mock("@opencode-ai/ui/toast", () => toast)
vi.mock("@opencode-ai/ui/app-icon", () => ({ AppIcon: () => null }))
vi.mock("@opencode-ai/ui/spinner", () => ({ Spinner: () => null }))
vi.mock("@/ui/controls/claxedo-icon", () => ({ ClaxedoIcon: () => null }))
vi.mock("@/ui/controls/claxedo-icon-button", () => ({
  ClaxedoIconButton: (props: { "aria-label"?: string; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" aria-label={props["aria-label"]} disabled={props.disabled} onClick={props.onClick} />
  ),
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; onClick?: () => void; "aria-label"?: string; disabled?: boolean }) => (
    <button type="button" aria-label={props["aria-label"]} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

// The real dictionary, so a key the component reads but no locale defines
// fails here rather than rendering its own name in the running app.
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const value = (en as Record<string, string>)[key]
      if (value === undefined) throw new Error(`missing i18n key: ${key}`)
      return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params?.[name] ?? "")
    },
  }),
}))

vi.mock("@/platform/persistence/persist", () => ({
  Persist: { global: (key: string) => ({ key }) },
  persisted: <T,>(_target: unknown, store: [T, (...args: unknown[]) => void]) => [store[0], store[1], null, () => true],
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Part = (props: { children?: JSX.Element }) => <div>{props.children}</div>
  const Trigger = (props: { "aria-label"?: string; disabled?: boolean }) => (
    <button type="button" aria-label={props["aria-label"]} disabled={props.disabled} />
  )
  const Selectable = (props: { children?: JSX.Element; onSelect?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={() => props.onSelect?.()}>
      {props.children}
    </button>
  )
  return {
    DropdownMenu: Object.assign(Part, {
      Trigger,
      Portal: Part,
      Content: Part,
      Group: Part,
      GroupLabel: Part,
      RadioGroup: Part,
      RadioItem: Selectable,
      Item: Selectable,
      ItemLabel: Part,
      ItemIndicator: Part,
      Separator: () => null,
    }),
  }
})

import { SessionOpenInControl } from "./session-header-open-in"

const WORKSPACE_PATH = "/Users/dev/projects/app"

const clipboard = { writeText: vi.fn() }

beforeEach(() => {
  toast.showToast.mockReset()
  clipboard.writeText.mockReset()
  clipboard.writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
})

afterEach(cleanup)

describe("SessionOpenInControl on the desktop", () => {
  const installed = new Set(["Visual Studio Code"])

  test("offers the file manager plus every installed target, and launches the one picked", async () => {
    const openPath = vi.fn().mockResolvedValue(undefined)
    const view = render(() => (
      <SessionOpenInControl
        path={WORKSPACE_PATH}
        os="macos"
        openPath={openPath}
        checkAppExists={async (app) => installed.has(app)}
      />
    ))

    await view.findByText("VS Code")
    expect(view.getByLabelText("Open options")).toBeInTheDocument()
    // Cursor is a menu target but is not installed on this machine.
    expect(view.queryByText("Cursor")).toBeNull()

    fireEvent.click(view.getByText("VS Code"))
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(WORKSPACE_PATH, "Visual Studio Code"))
  })

  test("the file manager launches with no app name", async () => {
    const openPath = vi.fn().mockResolvedValue(undefined)
    const view = render(() => (
      <SessionOpenInControl path={WORKSPACE_PATH} os="macos" openPath={openPath} checkAppExists={async () => false} />
    ))

    fireEvent.click(await view.findByText("Finder"))
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(WORKSPACE_PATH, undefined))
  })

  test("copy path is in the menu and writes the workspace path to the clipboard", async () => {
    const view = render(() => (
      <SessionOpenInControl
        path={WORKSPACE_PATH}
        os="macos"
        openPath={vi.fn().mockResolvedValue(undefined)}
        checkAppExists={async () => false}
      />
    ))

    fireEvent.click(await view.findByText("Copy path"))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(WORKSPACE_PATH))
  })
})

describe("SessionOpenInControl without a desktop bridge", () => {
  test("falls back to Copy path alone — the web build can launch nothing", async () => {
    const view = render(() => <SessionOpenInControl path={WORKSPACE_PATH} os="macos" />)

    expect(view.queryByTestId("session-open-in")).toBeNull()
    expect(view.queryByLabelText("Open options")).toBeNull()

    fireEvent.click(view.getByLabelText("Copy path"))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(WORKSPACE_PATH))
  })
})
