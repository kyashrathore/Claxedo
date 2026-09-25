import { createEffect, createMemo, type Accessor } from "solid-js"
import type { ComposerController } from "../controller"
import type { ComposerSetup } from "../setup"
import type { AtItem } from "../suggestions"
import type { PromptPopoverKind } from "./editor-surface"
import type { PromptPopoverBindings } from "./frame"
import { promptAtOptionKey } from "./prompt-options"
import type { AtOption } from "./slash-popover"

function atOption(item: AtItem): AtOption {
  if (item.kind === "file") return { type: "file", path: item.path, display: item.path }
  return { type: "document", documentId: item.id, display: item.entry.label, originKind: "managed", placementKind: "local", status: item.entry.group }
}

function createAtOptions(items: () => readonly AtItem[], controller: ComposerController) {
  const pairs = createMemo(() => items().map((item) => ({ item, option: atOption(item) })))
  const itemOf = (key: string) => pairs().find((pair) => promptAtOptionKey(pair.option) === key)?.item
  return {
    flat: createMemo(() => pairs().map((pair) => pair.option)),
    keyOf: (id: string | undefined) => {
      const pair = pairs().find((candidate) => candidate.item.id === id)
      return pair ? promptAtOptionKey(pair.option) : undefined
    },
    setActive: (key: string) => {
      const item = itemOf(key)
      if (item) controller.setActive(item.id)
    },
    select: (option: AtOption) => {
      const item = itemOf(promptAtOptionKey(option))
      if (item) controller.selectAt(item)
    },
  }
}

function followActiveSlashRow(popover: Accessor<PromptPopoverKind>, controller: ComposerController) {
  let slashPopover: HTMLDivElement | undefined
  createEffect(() => {
    if (popover() !== "slash") return
    const active = controller.state.activeId
    if (!active || !slashPopover) return
    requestAnimationFrame(() => slashPopover?.querySelector(`[data-slash-id="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }))
  })
  return (element: HTMLDivElement) => {
    slashPopover = element
  }
}

export function createPromptPopoverBindings(input: {
  composer: ComposerSetup
  popover: Accessor<PromptPopoverKind>
  keybind: (id: string) => string
}): PromptPopoverBindings {
  const controller = input.composer.controller
  const at = createAtOptions(input.composer.suggestions.atItems, controller)
  const setSlashPopoverRef = followActiveSlashRow(input.popover, controller)

  return {
    get popover() {
      return input.popover()
    },
    documentPicker: false,
    setSlashPopoverRef,
    get atFlat() {
      return at.flat()
    },
    get atActive() {
      return input.popover() === "at" ? at.keyOf(controller.state.activeId) : undefined
    },
    atKey: promptAtOptionKey,
    setAtActive: at.setActive,
    onAtSelect: at.select,
    get slashFlat() {
      return input.composer.suggestions.slashItems()
    },
    get slashActive() {
      return input.popover() === "slash" ? controller.state.activeId : undefined
    },
    setSlashActive: controller.setActive,
    onSlashSelect: controller.selectSlash,
    commandKeybind: (id) => input.keybind(id) || undefined,
  }
}
