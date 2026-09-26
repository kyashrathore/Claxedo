import { createMemo, createSelector, createSignal, For, onCleanup, Show } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { PALETTE_ID, useCommands, type Commands } from "@/shell"
import { showToast, Button, TextField } from "@/ui"
import { useTranslator } from "@/i18n"
import { settingsDictionary } from "../i18n"
import { clearsKeybinding, filterRows, firstRows, groupRows, keybindingFromEvent, type KeybindingRow } from "../keybindings"
import { createRevealLimit } from "./reveal"
import { SettingsGroup, SettingsList } from "./section"

const FIRST_ROWS = 40
const ROWS_PER_FRAME = 60

function keybindingRows(commands: Commands, labels: { readonly palette: string; readonly general: string }): KeybindingRow[] {
  const options = commands.options().filter((option) => commands.has(option.id))
  return [
    { id: PALETTE_ID, title: labels.palette, category: labels.general, keybind: commands.keybind(PALETTE_ID) },
    ...options.map((option) => ({ id: option.id, title: option.title, category: option.category ?? labels.general, keybind: commands.keybind(option.id) })),
  ]
}

export function KeybindingsSection() {
  const t = useTranslator(settingsDictionary)
  const commands = useCommands()
  const [recording, setRecording] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const rows = createMemo(() => keybindingRows(commands, { palette: t("settings.keybindings.palette"), general: t("settings.keybindings.group.general") }))
  const rowById = createMemo(() => new Map(rows().map((row) => [row.id, row])))
  const groups = createMemo(() => groupRows(filterRows(rows(), query())))
  const limit = createRevealLimit(() => rows().length, FIRST_ROWS, ROWS_PER_FRAME)
  const shown = createMemo(() => firstRows(groups(), limit()))
  const categories = createMemo(() => [...shown().keys()], [], { equals: (a, b) => a.length === b.length && a.every((category, index) => category === b[index]) })
  const isRecording = createSelector(recording)

  const stop = () => {
    if (recording() === undefined) return
    setRecording(undefined)
    commands.keybinds(true)
  }
  const start = (id: string) => {
    if (recording() === id) return stop()
    if (recording() === undefined) commands.keybinds(false)
    setRecording(id)
  }
  onCleanup(stop)

  makeEventListener(document, "keydown", (event: KeyboardEvent) => {
    const id = recording()
    if (id === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Escape") return stop()
    const next = clearsKeybinding(event) ? "none" : keybindingFromEvent(event)
    if (!next) return
    commands.setKeybind(id, next)
    stop()
  }, { capture: true })

  const resetAll = () => {
    stop()
    for (const row of rows()) commands.setKeybind(row.id, undefined)
    showToast({ title: t("settings.keybindings.resetDone") })
  }

  return (
    <div class="settings-body">
      <div class="settings-toolbar">
        <TextField label={t("settings.keybindings.search")} hideLabel placeholder={t("settings.keybindings.search")} value={query()} onChange={setQuery} />
        <Button size="small" variant="neutral" onClick={resetAll} disabled={!commands.overridden()}>{t("settings.keybindings.reset")}</Button>
      </div>
      <For each={categories()}>
        {(category) => {
          const ids = createMemo(() => (shown().get(category) ?? []).map((row) => row.id))
          return (
            <SettingsGroup title={category}>
              <SettingsList>
                <For each={ids()}>
                  {(id) => <Show when={rowById().get(id)}>{(row) => <KeybindingRowView row={row()} recording={isRecording(id)} onStart={() => start(id)} />}</Show>}
                </For>
              </SettingsList>
            </SettingsGroup>
          )
        }}
      </For>
      <Show when={query() && groups().length === 0}>
        <p class="settings-note">{t("settings.keybindings.empty")}</p>
      </Show>
    </div>
  )
}

function KeybindingRowView(props: { readonly row: KeybindingRow; readonly recording: boolean; readonly onStart: () => void }) {
  const t = useTranslator(settingsDictionary)
  const shown = () => (props.recording ? t("settings.keybindings.pressKeys") : props.row.keybind || t("settings.keybindings.unassigned"))
  return (
    <div class="settings-row">
      <span class="settings-row-text settings-row-title">{props.row.title}</span>
      <button type="button" class="settings-keybind" aria-label={t("settings.keybindings.edit", { command: props.row.title, keybind: shown() })} data-keybind-id={props.row.id} aria-pressed={props.recording} onClick={() => props.onStart()}>
        {shown()}
      </button>
    </div>
  )
}
