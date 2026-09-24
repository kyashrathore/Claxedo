import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { PALETTE_ID, useCommands, type Commands } from "@/shell"
import { showToast, TextInput, Button } from "@/ui"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { clearsKeybinding, filterRows, groupRows, keybindingFromEvent, type KeybindingRow } from "../keybindings"
import { SettingsGroup, SettingsList } from "./section"


function keybindingRows(commands: Commands, labels: { readonly palette: string; readonly general: string }): KeybindingRow[] {
  const options = commands.options().filter((option) => commands.has(option.id))
  return [
    { id: PALETTE_ID, title: labels.palette, category: labels.general, keybind: commands.keybind(PALETTE_ID) },
    ...options.map((option) => ({ id: option.id, title: option.title, category: option.category ?? labels.general, keybind: commands.keybind(option.id) })),
  ]
}

export function KeybindingsSection() {
  const t = useTranslator(dictionary)
  const commands = useCommands()
  const [recording, setRecording] = createSignal<string>()
  const [query, setQuery] = createSignal("")
  const rows = createMemo(() => keybindingRows(commands, { palette: t("settings.keybindings.palette"), general: t("settings.keybindings.group.general") }))
  const groups = createMemo(() => groupRows(filterRows(rows(), query())))

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
    <div class="settings-body" data-component="settings-keybindings">
      <div class="settings-toolbar">
        <TextInput aria-label={t("settings.keybindings.search")} placeholder={t("settings.keybindings.search")} value={query()} showClearButton={query() !== ""} onClearClick={() => setQuery("")} onInput={(event) => setQuery(event.currentTarget.value)} />
        <Button size="small" variant="secondary" onClick={resetAll} disabled={!commands.overridden()}>{t("settings.keybindings.reset")}</Button>
      </div>
      <For each={groups()}>
        {([category, list]) => (
          <SettingsGroup title={category}>
            <SettingsList>
              <For each={list}>{(row) => <KeybindingRowView row={row} recording={recording() === row.id} onStart={() => start(row.id)} />}</For>
            </SettingsList>
          </SettingsGroup>
        )}
      </For>
      <Show when={query() && groups().length === 0}>
        <p class="settings-note">{t("settings.keybindings.empty")}</p>
      </Show>
    </div>
  )
}

function KeybindingRowView(props: { readonly row: KeybindingRow; readonly recording: boolean; readonly onStart: () => void }) {
  const t = useTranslator(dictionary)
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
