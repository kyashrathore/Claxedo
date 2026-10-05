import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { copyText } from "@/lib/clipboard"
import { useServer, type Machine } from "@/server"
import { Button, ClaxedoIconButton, Drawer, useDialog } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsListSkeleton, SettingsRow } from "./section"

const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

function CommandLine(props: { readonly command: string; readonly label: string }) {
  const [copied, setCopied] = createSignal(false)
  const copy = () => {
    void copyText(props.command).then((result) => setCopied(result.copied))
  }
  return (
    <div class="settings-command">
      <code>{props.command}</code>
      <ClaxedoIconButton icon={copied() ? "check" : "copy"} size="small" variant="ghost" aria-label={props.label} onClick={copy} />
    </div>
  )
}

function Step(props: { readonly number: string; readonly title: string; readonly description: string; readonly children?: JSX.Element }) {
  return (
    <li class="settings-step">
      <span class="settings-step-number">{props.number}.</span>
      <div class="settings-step-body">
        <span class="settings-row-title">{props.title}</span>
        <span class="settings-row-description">{props.description}</span>
        {props.children}
      </div>
    </li>
  )
}

export function MachineConnectSteps() {
  const t = useTranslator(settingsDictionary)
  return (
    <ol class="settings-steps">
      <Step number="1" title={t("settings.machines.step.here")} description={t("settings.machines.step.here.description")} />
      <Step number="2" title={t("settings.machines.step.another")} description={t("settings.machines.step.another.description")}>
        <CommandLine command={INVITE_COMMAND} label={t("settings.machines.copyInvite")} />
        <CommandLine command={CONNECT_COMMAND} label={t("settings.machines.copyConnect")} />
      </Step>
    </ol>
  )
}

function ConnectMachineDrawer() {
  const t = useTranslator(settingsDictionary)
  const dialog = useDialog()
  return (
    <Drawer title={t("settings.machines.connect.title")} description={t("settings.machines.connect.description")} closeLabel={t("settings.machines.connect.done")} onClose={() => dialog.close()}>
      <MachineConnectSteps />
    </Drawer>
  )
}

export function useConnectMachine(): () => void {
  const dialog = useDialog()
  return () => dialog.show(() => <ConnectMachineDrawer />)
}

function machineStatus(machine: Machine): SettingsKey {
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
