import { Dialog } from "@kobalte/core/dialog"
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import "./palette.css"
import { useCommands } from "./commands"
import { groupRows, rowId, searchOptions, type PaletteRow } from "./palette-search"

function PaletteList(props: { rows: readonly PaletteRow[]; highlighted: number; onHover: (index: number) => void; onPick: (row: PaletteRow) => void }): JSX.Element {
  const commands = useCommands()
  const groups = createMemo(() => groupRows(props.rows))
  const indexOf = (row: PaletteRow) => props.rows.indexOf(row)
  return (
    <For each={groups()}>
      {(group) => (
        <li role="presentation" class="palette-group">
          <div class="palette-group-title" aria-hidden="true">{group.category}</div>
          <ul role="group" aria-label={group.category} class="palette-group-rows">
            <For each={group.rows}>
              {(row) => (
                <li
                  role="option"
                  id={rowId(row.option)}
                  class="palette-row"
                  aria-selected={indexOf(row) === props.highlighted}
                  data-highlighted={indexOf(row) === props.highlighted ? "true" : undefined}
                  onMouseMove={() => props.onHover(indexOf(row))}
                  onClick={() => props.onPick(row)}
                >
                  <span class="palette-row-title">{row.option.title}</span>
                  <Show when={row.option.description}>{(description) => <span class="palette-row-description">{description()}</span>}</Show>
                  <Show when={row.option.keybind}>
                    <span class="palette-row-keybind">{commands.keybindParts(row.option.id).join(" ")}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </li>
      )}
    </For>
  )
}

export function CommandPalette(): JSX.Element {
  const commands = useCommands()
  const t = useTranslator(dictionary)
  const [query, setQuery] = createSignal("")
  const [highlighted, setHighlighted] = createSignal(0)
  const rows = createMemo(() => searchOptions(commands.options(), query(), t("shell.category.view")))
  createEffect(on(rows, () => setHighlighted(0)))
  createEffect(on(commands.paletteOpen, (open) => open && setQuery("")))
  const pick = (row: PaletteRow) => {
    commands.hidePalette()
    row.option.onSelect?.("palette")
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const count = rows().length
    if (event.key === "ArrowDown") setHighlighted((index) => (count === 0 ? 0 : (index + 1) % count))
    else if (event.key === "ArrowUp") setHighlighted((index) => (count === 0 ? 0 : (index - 1 + count) % count))
    else if (event.key === "Enter") {
      const row = rows()[highlighted()]
      if (row) pick(row)
    } else return
    event.preventDefault()
  }
  const activeId = () => {
    const row = rows()[highlighted()]
    return row ? rowId(row.option) : undefined
  }

  return (
    <Dialog open={commands.paletteOpen()} onOpenChange={(open) => (open ? commands.showPalette() : commands.hidePalette())}>
      <Dialog.Portal>
        <Dialog.Overlay class="palette-overlay" />
        <Dialog.Content class="palette" aria-label={t("shell.palette.title")} data-testid="command-palette">
          <Dialog.Title class="palette-title">{t("shell.palette.title")}</Dialog.Title>
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeId()}
            aria-label={t("shell.palette.title")}
            class="palette-input"
            placeholder={t("shell.palette.placeholder")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            ref={(el) => queueMicrotask(() => el.focus())}
          />
          <ul id="palette-listbox" role="listbox" aria-label={t("shell.palette.title")} class="palette-list">
            <Show when={rows().length > 0} fallback={<li class="palette-empty" role="presentation">{t("shell.palette.empty")}</li>}>
              <PaletteList rows={rows()} highlighted={highlighted()} onHover={setHighlighted} onPick={pick} />
            </Show>
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
