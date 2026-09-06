import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { openTableViewer } from "./markdown-viewer"

const triggers: HTMLElement[] = []
let previousOverflow = ""
beforeEach(() => { previousOverflow = document.body.style.overflow })

afterEach(() => {
  document.querySelector<HTMLButtonElement>('[data-component="table-viewer"] [data-action="close"]')?.click()
  document.body.style.overflow = previousOverflow
  for (const trigger of triggers.splice(0)) trigger.remove()
})

describe("timeline table dialog viewer", () => {
  test("opens an isolated table, traps focus, and restores the page on close", () => {
    const trigger = document.createElement("button")
    triggers.push(trigger)
    const table = document.createElement("table")
    table.innerHTML = "<thead><tr><th>Harness</th></tr></thead><tbody><tr><td>codex-acp</td></tr></tbody>"
    document.body.appendChild(trigger)
    trigger.focus()
    document.body.style.overflow = "clip"

    openTableViewer(table)

    const viewer = document.querySelector<HTMLElement>('[data-component="table-viewer"]')
    const dialog = viewer?.querySelector<HTMLElement>('[data-slot="table-viewer-dialog"]')
    const viewport = viewer?.querySelector<HTMLElement>('[data-slot="table-viewer-viewport"]')
    const rendered = viewer?.querySelector<HTMLTableElement>("table")

    expect(dialog?.getAttribute("role")).toBe("dialog")
    expect(dialog?.getAttribute("aria-label")).toBe("Table viewer")
    expect(rendered).not.toBe(table)
    expect(rendered?.textContent).toContain("codex-acp")
    expect(document.body.style.overflow).toBe("hidden")
    expect(document.activeElement).toBe(viewport)

    const close = viewer!.querySelector<HTMLButtonElement>('[data-action="close"]')!
    viewer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(close)
    viewer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(viewport)
    viewer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(close)

    viewer?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(document.querySelector('[data-component="table-viewer"]')).toBeNull()
    expect(document.body.style.overflow).toBe("clip")
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
