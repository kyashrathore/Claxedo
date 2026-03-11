import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"

const fetch = vi.fn()
const close = vi.fn()
const toast = vi.fn()
const capture = vi.fn()

type Bag = Record<string, unknown> & {
  children?: unknown
}

function kids(value: unknown): JSX.Element {
  return value as JSX.Element
}

function buttonType(value: unknown): "button" | "submit" | "reset" | undefined {
  if (value === "button" || value === "submit" || value === "reset") return value
  return "button"
}

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: Bag) => <div data-testid="dialog">{kids(props.children)}</div>,
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: Bag) => (
    <button
      type={buttonType(props.type)}
      onClick={typeof props.onClick === "function" ? (props.onClick as () => void) : undefined}
      disabled={props.disabled === true}
    >
      {kids(props.children)}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/text-field", () => ({
  TextField: (props: Bag) => (
    <label>
      <span>{kids(props.label)}</span>
      <input
        aria-label={typeof props.label === "string" ? props.label : ""}
        type={typeof props.type === "string" ? props.type : "text"}
        placeholder={typeof props.placeholder === "string" ? props.placeholder : undefined}
        value={typeof props.value === "string" ? props.value : ""}
        onInput={(event) => {
          if (typeof props.onChange === "function") {
            ;(props.onChange as (value: string) => void)(event.currentTarget.value)
          }
        }}
      />
      {props.description ? <span>{kids(props.description)}</span> : null}
    </label>
  ),
}))

vi.mock("@opencode-ai/ui/switch", () => ({
  Switch: (props: Bag) => (
    <label>
      <input
        aria-label={typeof props.children === "string" ? props.children : "switch"}
        type="checkbox"
        checked={props.checked === true}
        onChange={(event) => {
          if (typeof props.onChange === "function") {
            ;(props.onChange as (value: boolean) => void)(event.currentTarget.checked)
          }
        }}
      />
      <span>{kids(props.children)}</span>
    </label>
  ),
}))

vi.mock("@opencode-ai/ui/icon", () => ({
  Icon: () => <span />,
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    close,
  }),
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: (...args: unknown[]) => toast(...args),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    url: "http://localhost:4096",
    directory: "/tmp/ws",
  }),
}))

vi.mock("@/context/platform", () => ({
  usePlatform: () => ({
    fetch,
  }),
}))

vi.mock("../../opencode-patches/observability/posthog", () => ({
  capture: (...args: unknown[]) => capture(...args),
}))

import { AddProcessDialog } from "./add-process-dialog"

beforeEach(() => {
  fetch.mockReset()
  close.mockReset()
  toast.mockReset()
  capture.mockReset()
  fetch.mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({}),
  })
})

afterEach(() => {
  cleanup()
})

describe("AddProcessDialog", () => {
  test("shows preferred port without opening advanced settings", () => {
    render(() => <AddProcessDialog />)

    expect(screen.getByLabelText("Preferred port")).toBeTruthy()
    expect(screen.queryByLabelText("Port name")).toBeNull()
  })

  test("submitting a preferred port auto-enables derived port defaults", async () => {
    render(() => <AddProcessDialog />)

    await fireEvent.input(screen.getByLabelText("Name"), {
      target: { value: "Web App" },
    })
    await fireEvent.input(screen.getByLabelText("Command"), {
      target: { value: "bun run dev" },
    })
    await fireEvent.input(screen.getByLabelText("Preferred port"), {
      target: { value: "3000" },
    })
    await fireEvent.click(screen.getByText("Add"))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.port).toEqual({
      name: "web-app",
      inject: "PORT",
      preferred: 3000,
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
