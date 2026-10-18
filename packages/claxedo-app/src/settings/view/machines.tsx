import { For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { useServer, type Machine } from "@/server"
import { Button } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { useConnectMachine } from "./machine-connect"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsListSkeleton, SettingsRow } from "./section"

function machineStatus(machine: Machine): SettingsKey {
  if (machine.paused) return "settings.machines.paused"
  if (!machine.online) return "settings.machines.offline"
  if (!machine.isThisMachine) return "settings.machines.connected"
  return machine.enrolled ? "settings.machines.reachableElsewhere" : "settings.machines.reachableHereOnly"
}

function MachineRow(props: { readonly machine: Machine }) {
  const t = useTranslator(settingsDictionary)
  return (
    <SettingsRow
      leading={<span class="settings-dot" data-tone={props.machine.online ? "success" : "muted"} aria-hidden="true" />}
      title={props.machine.name}
      description={t(machineStatus(props.machine))}
    />
  )
}

function MachineList(props: { readonly machines: readonly Machine[]; readonly action: JSX.Element }) {
  const t = useTranslator(settingsDictionary)
  return (
    <Show
      when={props.machines.length > 0}
      fallback={
        <SettingsEmpty>
          <span class="settings-empty-line">
            <span>{t("settings.machines.empty")}</span>
            {props.action}
          </span>
        </SettingsEmpty>
      }
    >
      <SettingsList>
        <For each={props.machines}>{(machine) => <MachineRow machine={machine} />}</For>
      </SettingsList>
    </Show>
  )
}

export function MachinesSection() {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  const server = useServer()
  const connect = useConnectMachine()
  const query = useQuery(() => server.queries.machines.list())
  const action = (
    <Button size="small" variant="ghost" data-action="add-machine" onClick={connect}>
      {t("settings.machines.connect.action")}
    </Button>
  )
  return (
    <div class="settings-body">
      <SettingsIntro description={t("settings.machines.description")} />
      <SettingsGroup title={t("settings.machines.yours")} action={query.data && query.data.length > 0 ? action : undefined}>
        <Switch fallback={<SettingsListSkeleton />}>
          <Match when={query.data}>{(machines) => <MachineList machines={machines()} action={action} />}</Match>
          <Match when={query.error}>
            {(error) => <FailureNotice title={t("settings.machines.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={() => void query.refetch()} />}
          </Match>
        </Switch>
      </SettingsGroup>
    </div>
  )
}
