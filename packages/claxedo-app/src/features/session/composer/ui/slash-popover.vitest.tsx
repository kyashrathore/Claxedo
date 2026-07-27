/**
 * PromptPopover — @-mention / slash-command popup ARIA (WP-C1).
 *
 * Locks the combobox/listbox semantics the composer's `role="combobox"` depends
 * on: the popup is a named `role="listbox"` and each row is a `role="option"`
 * with a stable id and an `aria-selected` that tracks the active item. Without
 * this the popover's keyboard nav is invisible to assistive tech (the appendix's
 * top "[critical]" a11y finding).
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import {
  PromptPopover,
  PROMPT_POPOVER_LISTBOX_ID,
  promptAtOptionId,
  promptSlashOptionId,
  type AtOption,
  type SlashCommand,
} from "./slash-popover"

afterEach(cleanup)

const t = (key: string) => key

const slashCommands: SlashCommand[] = [
  { id: "init", trigger: "init", title: "Init", type: "builtin" },
  { id: "compact", trigger: "compact", title: "Compact", type: "builtin" },
]

const atOptions: AtOption[] = [
  { type: "agent", name: "build", display: "build" },
  { type: "file", path: "src/app.ts", display: "src/app.ts" },
]

function base() {
  return {
    documentPicker: false,
    setSlashPopoverRef: () => {},
    atFlat: [] as AtOption[],
    atKey: (item: AtOption) => {
      if (item.type === "agent") return `agent:${item.name}`
      if (item.type === "document") return `document:${item.documentId}`
      return `file:${item.path}`
    },
    setAtActive: () => {},
    onAtSelect: () => {},
    slashFlat: [] as SlashCommand[],
    setSlashActive: () => {},
    onSlashSelect: () => {},
    commandKeybind: () => undefined,
    t,
  }
}

describe("PromptPopover ARIA", () => {
  test("slash popup is a named listbox whose options carry ids and track aria-selected", () => {
    const view = render(() => (
      <PromptPopover {...base()} popover="slash" slashFlat={slashCommands} slashActive="compact" />
    ))
    const listbox = view.getByRole("listbox")
    expect(listbox.id).toBe(PROMPT_POPOVER_LISTBOX_ID)
    expect(listbox.classList.contains("theme-overlay-surface")).toBe(true)
    expect(listbox.getAttribute("aria-label")).toBe("prompt.popover.slashLabel")

    const options = view.getAllByRole("option")
    expect(options.map((o) => o.id)).toEqual([promptSlashOptionId("init"), promptSlashOptionId("compact")])
    // aria-selected marks exactly the active command.
    expect(view.container.querySelector(`#${promptSlashOptionId("compact")}`)?.getAttribute("aria-selected")).toBe(
      "true",
    )
    expect(view.container.querySelector(`#${promptSlashOptionId("init")}`)?.getAttribute("aria-selected")).toBe("false")
  })

  test("@-mention popup is a listbox of options ided by atKey and named for mentions", () => {
    const view = render(() => (
      <PromptPopover {...base()} popover="at" atFlat={atOptions} atActive="file:src/app.ts" />
    ))
    const listbox = view.getByRole("listbox")
    expect(listbox.getAttribute("aria-label")).toBe("prompt.popover.atLabel")

    const options = view.getAllByRole("option")
    // ids can contain `:` / `/` (agent name, file path) — valid HTML ids and
    // valid `aria-activedescendant` idrefs, so assert via the option list rather
    // than a `#` CSS selector (which would need escaping).
    expect(options.map((o) => o.id)).toEqual([promptAtOptionId("agent:build"), promptAtOptionId("file:src/app.ts")])
    expect(options[0].getAttribute("aria-selected")).toBe("false")
    expect(options[1].getAttribute("aria-selected")).toBe("true")
  })

  test("renders nothing when the popover is closed", () => {
    const view = render(() => <PromptPopover {...base()} popover={null} />)
    expect(view.container.querySelector('[role="listbox"]')).toBeNull()
  })

  test("labels document picker options with honest metadata", () => {
    const documents: AtOption[] = [{
      type: "document", documentId: "doc-1", display: "Plan", originKind: "managed", placementKind: "local", status: "draft",
    }]
    const view = render(() => (
      <PromptPopover {...base()} documentPicker popover="at" atFlat={documents} atActive="document:doc-1" />
    ))
    expect(view.getByRole("listbox").getAttribute("aria-label")).toBe("Documents")
    expect(view.getByRole("option").textContent).toContain("Plan")
    expect(view.getByRole("option").textContent).toContain("draft")
  })
})
