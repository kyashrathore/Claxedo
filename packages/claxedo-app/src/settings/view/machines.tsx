import { For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { useServer, type Machine, type MachineEnrollment } from "@/server"
import { Button, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"
import { useConnectMachine } from "../connect-machine"
import { MachineDetails } from "./machine-details"
import { MachineDot, MachineStatus } from "./machine-status"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsListSkeleton, SettingsRow } from "./section"

function DetailsButton(props: { readonly name: string; readonly enrollment: MachineEnrollment }) {
  const t = useTranslator(settingsDictionary)
  const dialog = useDialog()
  const open = () => dialog.show(() => <MachineDetails hostId={props.enrollment.hostId} name={props.name} />)
  return (
    <Button size="small" variant="ghost" aria-label={t("settings.machines.details.label", { name: props.name })} onClick={open}>
      {t("settings.machines.details")}
    </Button>
  )
}

function MachineRow(props: { readonly machine: Machine }) {
  return (
    <SettingsRow leading={<MachineDot machine={props.machine} />} title={props.machine.name} description={<MachineStatus machine={props.machine} />}>
      <Show when={props.machine.enrollment}>{(enrollment) => <DetailsButton name={props.machine.name} enrollment={enrollment()} />}</Show>
    </SettingsRow>
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
