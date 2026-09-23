import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Button, showToast, TextInput } from "@/ui"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import {
  conflictsFor,
  filterRows,
  groupFor,
  groupRows,
  KEYBINDING_GROUPS,
  PALETTE_COMMAND_ID,
  recordKeybind,
  type KeybindingGroup,
  type KeybindingRow,
} from "../keybindings"
import { useCommands } from "../placeholders"
import { SettingsGroup, SettingsHeading, SettingsList } from "./section"

const GROUP_KEY = {
  general: "settings.keybindings.group.general",
  session: "settings.keybindings.group.session",
  navigation: "settings.keybindings.group.navigation",
  model: "settings.keybindings.group.model",
  terminal: "settings.keybindings.group.terminal",
  prompt: "settings.keybindings.group.prompt",
} as const satisfies Record<KeybindingGroup, string>

export function KeybindingsSection() {
  const t = useTranslator(dictionary)
  const commands = useCommands()
  const [recording, setRecording] = createSignal<string>()
  const [query, setQuery] = createSignal("")

  const rows = createMemo<KeybindingRow[]>(() => {
    const listed = commands.list().map((entry) => ({ id: entry.id, title: entry.title(), group: groupFor(entry.id), keybind: commands.keybind(entry.id) ?? entry.keybind }))
    if (listed.some((row) => row.id === PALETTE_COMMAND_ID)) return listed
    return [{ id: PALETTE_COMMAND_ID, title: "Command palette", group: "general", keybind: commands.keybind(PALETTE_COMMAND_ID) ?? "mod+shift+p" }, ...listed]
  })
  const grouped = createMemo(() => groupRows(filterRows(rows(), query())))
  const hasResults = () => [...grouped().values()].some((list) => list.length > 0)

  const stop = () => {
    if (recording() === undefined) return
    setRecording(undefined)
    commands.captureEnabled(true)
  }
  const start = (id: string) => {
    if (recording() === id) return stop()
    setRecording(id)
    commands.captureEnabled(false)
  }
  onCleanup(stop)

  const capture = (event: KeyboardEvent) => {
    const id = recording()
    if (id === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Escape") return stop()
    const clear = (event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (clear) {
      commands.setKeybind(id, "none")
      return stop()
    }
    const next = recordKeybind(event)
    if (!next) return
    const conflicts = conflictsFor(rows(), id, next)
    if (conflicts.length > 0) {
      showToast({ title: t("settings.keybindings.conflict"), description: t("settings.keybindings.conflict.description", { keybind: next, titles: conflicts.map((row) => row.title).join(", ") }) })
      return
    }
    commands.setKeybind(id, next)
    stop()
  }
  makeEventListener(document, "keydown", capture, { capture: true })

  const resetAll = () => {
    stop()
    commands.resetKeybinds()
    showToast({ title: t("settings.keybindings.resetDone") })
  }

  return (
    <div class="settings-page" data-component="settings-keybindings">
      <SettingsHeading
        title={t("settings.keybindings.title")}
        action={<Button size="small" onClick={resetAll} disabled={!commands.hasOverrides()}>{t("settings.keybindings.reset")}</Button>}
      />
      <div class="settings-search">
        <TextInput aria-label={t("settings.keybindings.search")} placeholder={t("settings.keybindings.search")} value={query()} showClearButton={query() !== ""} onClearClick={() => setQuery("")} onInput={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <For each={KEYBINDING_GROUPS}>
        {(group) => (
          <Show when={(grouped().get(group) ?? []).length > 0}>
            <SettingsGroup title={t(GROUP_KEY[group])}>
              <SettingsList>
                <For each={grouped().get(group) ?? []}>
                  {(row) => <KeybindingRowView row={row} recording={recording() === row.id} onStart={() => start(row.id)} />}
                </For>
              </SettingsList>
            </SettingsGroup>
          </Show>
        )}
      </For>
      <Show when={query() && !hasResults()}>
        <p class="settings-note">{t("settings.keybindings.empty")}</p>
      </Show>
    </div>
  )
}

function KeybindingRowView(props: { readonly row: KeybindingRow; readonly recording: boolean; readonly onStart: () => void }) {
  const t = useTranslator(dictionary)
  const shown = () => (props.recording ? t("settings.keybindings.pressKeys") : (props.row.keybind && props.row.keybind !== "none" ? props.row.keybind : t("settings.keybindings.unassigned")))
  return (
    <div class="settings-row">
      <span class="settings-row-text settings-row-title">{props.row.title}</span>
      <button type="button" class="settings-keybind" data-keybind-id={props.row.id} data-recording={props.recording ? "" : undefined} aria-pressed={props.recording} onClick={() => props.onStart()}>
        {shown()}
      </button>
    </div>
  )
}
