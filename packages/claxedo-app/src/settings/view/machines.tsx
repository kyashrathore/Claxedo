import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useAuth } from "@/auth"
import { useTranslator } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import { useServer, type Machine } from "@/server"
import { Button, ClaxedoIconButton, Tag } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { SettingsGroup, SettingsIntro, SettingsList, SettingsRow } from "./section"

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

function AddMachine(props: { readonly empty: boolean }) {
  const t = useTranslator(settingsDictionary)
  const [open, setOpen] = createSignal(false)
  return (
    <div class="settings-add-machine">
      <Show when={!props.empty}>
        <Button size="small" variant="ghost" data-action="add-machine" aria-expanded={open()} onClick={() => setOpen(!open())}>
          {t(open() ? "settings.machines.hideInstructions" : "settings.machines.addAnother")}
        </Button>
      </Show>
      <Show when={props.empty || open()}>
        <div class="settings-instructions">
          <Show when={props.empty}>
            <p class="settings-row-description">{t("settings.machines.empty")}</p>
          </Show>
          <ol class="settings-steps">
            <Step number="1" title={t("settings.machines.step.here")} description={t("settings.machines.step.here.description")} />
            <Step number="2" title={t("settings.machines.step.another")} description={t("settings.machines.step.another.description")}>
              <CommandLine command={INVITE_COMMAND} label={t("settings.machines.copyInvite")} />
              <CommandLine command={CONNECT_COMMAND} label={t("settings.machines.copyConnect")} />
            </Step>
          </ol>
        </div>
      </Show>
    </div>
  )
}

function machineStatus(machine: Machine): SettingsKey {
  if (!machine.online) return "settings.machines.offline"
  if (!machine.isThisMachine) return "settings.machines.connected"
  return machine.enrolled ? "settings.machines.reachableElsewhere" : "settings.machines.reachableHereOnly"
}

function listedMachines(machines: readonly Machine[]): readonly Machine[] {
  const listed = machines.filter((machine) => machine.enrolled || machine.isThisMachine)
  return [...listed.filter((machine) => machine.isThisMachine), ...listed.filter((machine) => !machine.isThisMachine)]
}

function MachineRow(props: { readonly machine: Machine }) {
  const t = useTranslator(settingsDictionary)
  return (
    <SettingsRow
      leading={<span class="settings-dot" data-tone={props.machine.online ? "success" : "muted"} aria-hidden="true" />}
      title={
        <span class="settings-machine-title">
          <span>{props.machine.name}</span>
          <Show when={props.machine.isThisMachine}>
            <Tag>{t("settings.machines.thisComputer")}</Tag>
          </Show>
        </span>
      }
      description={t(machineStatus(props.machine))}
    />
  )
}

export function MachinesSection() {
  const t = useTranslator(settingsDictionary)
  const auth = useAuth()
  const server = useServer()
  const signedIn = () => auth.state().kind === "signedIn"
  const query = useQuery(() => server.queries.machines.list())
  const machines = createMemo(() => listedMachines(query.data ?? []))
  return (
    <div class="settings-body">
      <SettingsIntro description={t("settings.machines.description")} />
      <SettingsGroup title={t("settings.machines.remoteAccess")}>
        <SettingsList variant="outline">
          <SettingsRow
            leading={<span class="settings-dot" data-tone="muted" aria-hidden="true" />}
            title={t(signedIn() ? "settings.machines.remoteAccess.unavailable" : "settings.machines.remoteAccess.signIn")}
            description={t(signedIn() ? "settings.machines.remoteAccess.unavailable.description" : "settings.machines.remoteAccess.signIn.description")}
          >
            <Button size="small" variant="neutral" disabled>
              {t("settings.machines.remoteAccess.enable")}
            </Button>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title={t("settings.machines.yours")} description={t("settings.machines.yours.description")}>
        <Show when={machines().length > 0}>
          <SettingsList>
            <For each={machines()}>{(machine) => <MachineRow machine={machine} />}</For>
          </SettingsList>
        </Show>
        <AddMachine empty={machines().length === 0} />
      </SettingsGroup>
    </div>
  )
}
