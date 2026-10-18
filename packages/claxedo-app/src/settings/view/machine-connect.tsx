import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import { ClaxedoIconButton, Drawer, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"

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
