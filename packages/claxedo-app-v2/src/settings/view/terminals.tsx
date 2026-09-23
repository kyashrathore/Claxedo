import { createMemo, For, Index, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Button, IconButton, showToast, TextInput } from "@/ui"
import { useTranslator } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { dictionary } from "../i18n"
import { useTerminalCommands, type TerminalCustomCommand } from "../placeholders"
import { SettingsGroup, SettingsHeading, SettingsList, SettingsNote } from "./section"

export function TerminalsSection() {
  const t = useTranslator(dictionary)
  const terminal = useTerminalCommands()
  const [agents, setAgents] = createStore<Record<string, string>>({ ...terminal.commands().agents })
  const [custom, setCustom] = createStore<TerminalCustomCommand[]>([...terminal.commands().custom])
  const changed = createMemo(() => {
    const saved = terminal.commands()
    const agentsChanged = terminal.agents.some((agent) => (agents[agent.id] ?? "") !== (saved.agents[agent.id] ?? ""))
    return agentsChanged || JSON.stringify(custom) !== JSON.stringify(saved.custom)
  })

  const save = () => {
    terminal.save({ agents: { ...agents }, custom: custom.map((entry) => ({ ...entry })) })
    showToast({ title: t("settings.terminals.saved") })
  }
  const reset = () => {
    terminal.reset()
    const saved = terminal.commands()
    setAgents(produce((draft) => {
      for (const key of Object.keys(draft)) delete draft[key]
      Object.assign(draft, saved.agents)
    }))
    setCustom([...saved.custom])
  }

  return (
    <div class="settings-page" data-component="settings-terminals">
      <SettingsHeading title={t("settings.terminals.title")} description={t("settings.terminals.description")} />
      <SettingsGroup title={t("settings.terminals.agents")}>
        <SettingsList>
          <For each={terminal.agents}>
            {(agent) => (
              <div class="settings-fields">
                <span class="settings-row-title">{agent.label}</span>
                <span class="settings-row-description">{agent.hint}</span>
                <TextInput aria-label={agent.label} value={agents[agent.id] ?? ""} placeholder={agent.defaultCommand} onInput={(event) => setAgents(agent.id, event.currentTarget.value)} />
              </div>
            )}
          </For>
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup
        title={t("settings.terminals.custom")}
        description={t("settings.terminals.custom.description")}
        action={<Button size="small" icon="plus-small" onClick={() => setCustom(custom.length, { id: uuid(), name: "", command: "" })}>{t("settings.terminals.add")}</Button>}
      >
        <SettingsList>
          <Show when={custom.length > 0} fallback={<SettingsNote>{t("settings.terminals.empty")}</SettingsNote>}>
            <Index each={custom}>
              {(command, index) => (
                <div class="settings-fields settings-inline">
                  <TextInput aria-label={t("settings.terminals.name")} placeholder={t("settings.terminals.name")} value={command().name} onInput={(event) => setCustom(index, "name", event.currentTarget.value)} />
                  <TextInput aria-label={t("settings.terminals.command")} placeholder={t("settings.terminals.command")} value={command().command} onInput={(event) => setCustom(index, "command", event.currentTarget.value)} />
                  <IconButton icon="trash" size="small" variant="ghost" aria-label={t("settings.terminals.removeCommand")} onClick={() => setCustom(produce((list) => list.splice(index, 1)))} />
                </div>
              )}
            </Index>
          </Show>
        </SettingsList>
      </SettingsGroup>
      <div class="settings-inline">
        <Button size="small" variant="contrast" onClick={save} disabled={!changed()}>{t("settings.common.save")}</Button>
        <Button size="small" variant="ghost" onClick={reset}>{t("settings.terminals.reset")}</Button>
      </div>
    </div>
  )
}
