import { createSignal, For, Show } from "solid-js"
import { useTranslator } from "@/i18n"
import { surfaceDictionary } from "../i18n"
import type { SlashMenuHost, SlashMenuState } from "../rich-text/slash-extension"
import type { BlockCommandId } from "../rich-text/slash-commands"
import { slashMenuPlacement } from "../rich-text/slash-placement"

export const BLOCK_COMMAND_KEYS = {
  text: "surface.editor.command.text",
  heading1: "surface.editor.command.heading1",
  heading2: "surface.editor.command.heading2",
  heading3: "surface.editor.command.heading3",
  bulletList: "surface.editor.command.bulletList",
  numberedList: "surface.editor.command.numberedList",
  todoList: "surface.editor.command.todoList",
  quote: "surface.editor.command.quote",
  codeBlock: "surface.editor.command.codeBlock",
  divider: "surface.editor.command.divider",
} as const satisfies Record<BlockCommandId, string>

export type SlashMenu = {
  readonly host: SlashMenuHost
  readonly state: () => SlashMenuState | undefined
  readonly active: () => number
  readonly choose: (index: number) => void
}

function wrapped(index: number, count: number): number {
  return count === 0 ? 0 : (index + count) % count
}

export function createSlashMenu(): SlashMenu {
  const [state, setState] = createSignal<SlashMenuState>()
  const [active, setActive] = createSignal(0)
  const host: SlashMenuHost = {
    show: (next) => {
      if (state()?.items !== next.items) setActive(0)
      setState(next)
    },
    hide: () => setState(undefined),
    key: (event) => {
      const current = state()
      if (!current) return false
      const count = current.items.length
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setActive((index) => wrapped(index + (event.key === "ArrowDown" ? 1 : -1), count))
        return true
      }
      if (event.key === "Enter") {
        const command = current.items[active()]
        if (command) current.pick(command)
        return command !== undefined
      }
      if (event.key !== "Escape") return false
      event.stopPropagation()
      setState(undefined)
      return true
    },
  }
  return { host, state, active, choose: setActive }
}

export function SlashMenuList(props: { readonly menu: SlashMenu; readonly frame: () => HTMLElement | undefined }) {
  const t = useTranslator(surfaceDictionary)
  const position = () => {
    const anchor = props.menu.state()?.anchor
    const frame = props.frame()
    return anchor && frame ? slashMenuPlacement(anchor, frame.getBoundingClientRect(), window.innerHeight) : undefined
  }
  return (
    <Show when={props.menu.state()}>
      {(current) => (
          <div data-slot="surface-slash-menu" role="listbox" aria-label={t("surface.editor.commands")} style={position()}>
            <For each={current().items} fallback={<div data-slot="surface-slash-empty">{t("surface.editor.noMatches")}</div>}>
              {(command, index) => (
                <div
                  role="option"
                  data-slot="surface-slash-option"
                  aria-selected={index() === props.menu.active()}
                  onPointerEnter={() => props.menu.choose(index())}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    current().pick(command)
                  }}
                >
                  {t(BLOCK_COMMAND_KEYS[command.id])}
                </div>
              )}
            </For>
          </div>
      )}
    </Show>
  )
}
