import { createSignal } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { permissionRowText, PromptPermissionControl } from "./permission-control"
import type { PermissionModeRow } from "@/features/session/composer/permission-mode"
import type { PermissionModeOption } from "@/features/session/permission/modes"

afterEach(cleanup)

function row(option: Partial<PermissionModeOption>, extra: Partial<PermissionModeRow> = {}): PermissionModeRow {
  return {
    option: {
      id: "auto",
      name: "Allow reads and edits",
      description: "Reads and in-project edits run without asking",
      origin: "harness",
      delivery: { kind: "harness-permission-mode", modeId: "auto", appliesFrom: "next-turn" },
      ...option,
    } as PermissionModeOption,
    selectable: true,
    ...extra,
  }
}

describe("permissionRowText", () => {
  test("keeps the caveat separate from the detail line", () => {
    const text = permissionRowText(
      row({ description: "Everything runs unattended", caveat: "the harness enforces nothing" }),
    )
    expect(text.detail).toBe("Everything runs unattended")
    expect(text.caveat).toBe("the harness enforces nothing")
  })



  test("no caveat means no caveat", () => {
    expect(permissionRowText(row({})).caveat).toBeUndefined()
  })

  test("a blocked row explains why, in the detail line", () => {
    const text = permissionRowText(
      row({ description: "Auto-approve" }, { selectable: false, blockedReason: "cursor-sdk exposes no controls" }),
    )
    expect(text.detail).toBe("Auto-approve — cursor-sdk exposes no controls")
  })

  test("the tooltip carries everything, because the detail line is clamped", () => {
    const text = permissionRowText(
      row({ description: "Auto-approve", caveat: "needs a model that supports it" }, { blockedReason: "not wired" }),
    )
    expect(text.tooltip).toBe("Auto-approve — not wired — needs a model that supports it")
  })

  test("a row with nothing to say still names itself", () => {
    const text = permissionRowText(row({ description: undefined, name: "Ask for everything" }))
    expect(text.tooltip).toBe("Ask for everything")
  })
})

describe("PromptPermissionControl", () => {
  test("accessible trigger name follows the actual current mode", () => {
    const approved = row({ id: "agent", name: "Approve for me" })
    const ask = row({ id: "read-only", name: "Ask for approval" })
    const [current, setCurrent] = createSignal(approved.option)
    render(() => <PromptPermissionControl
      enabled={() => true} disabled={() => false} style={() => ({})}
      groups={() => ({ harness: { label: "Agent", rows: [approved, ask] } })}
      current={current} label="Approve for me" onSelect={() => {}}
    />)
    expect(screen.getByRole("button", { name: "Approve for me" })).toBeTruthy()
    setCurrent(ask.option)
    expect(screen.getByRole("button", { name: "Ask for approval" })).toHaveTextContent("Ask for approval")
    expect(screen.queryByRole("button", { name: "Approve for me" })).toBeNull()
  })

  test("renders the caveat in the opened menu and selects its actual option", async () => {
    const caveat = "Claxedo answers these prompts on your behalf; the harness enforces nothing"
    const item = row({ caveat })
    const selected: PermissionModeOption[] = []
    render(() => <PromptPermissionControl
      enabled={() => true} disabled={() => false} style={() => ({})}
      groups={() => ({ harness: { label: "Harness", rows: [item] } })}
      current={() => undefined} label="Permissions" onSelect={(option) => selected.push(option)}
    />)
    // Kobalte menu triggers open on pointer or ArrowDown, never on a synthetic click.
    fireEvent.keyDown(screen.getByRole("button", { name: "Permissions" }), { key: "ArrowDown" })
    await screen.findByRole("menu")
    const renderedCaveat = await screen.findByText(caveat)
    expect(renderedCaveat).toBeVisible()
    expect(renderedCaveat.closest('[data-permission-mode-row]')).not.toBeNull()
    fireEvent.keyDown(renderedCaveat.closest('[data-permission-mode-row]')!, { key: "Enter" })
    expect(selected).toEqual([item.option])
  })
})
