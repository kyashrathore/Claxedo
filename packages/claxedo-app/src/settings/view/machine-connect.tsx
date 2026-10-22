import { createSignal, Match, Show, Switch, untrack, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import { useServer } from "@/server"
import { Button, ClaxedoIconButton, Drawer, TextField, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"
import { createConnectWait, knownHostIds, type ConnectWait } from "../machines"

const DEFAULT_NAME = "build-box"
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

function shellWord(value: string): string {
  return /^[\w.@%+=:,/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

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

function WaitLine(props: { readonly state: ConnectWait }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  return (
    <Switch>
      <Match when={(props.state.kind === "checking" || props.state.kind === "waiting") && props.state}>
        {(waiting) => <p class="settings-row-description" role="status">{t("settings.machines.connect.waiting", { name: waiting().name })}</p>}
      </Match>
      <Match when={props.state.kind === "connected" && props.state}>
        {(connected) => <p class="settings-row-title" role="status">{t("settings.machines.connect.connected", { name: connected().machine.name })}</p>}
      </Match>
      <Match when={props.state.kind === "failed" && props.state}>
        {(failed) => <p class="settings-note" data-tone="danger" role="alert">{t("settings.machines.connect.failed", { name: failed().name, reason: errorCopy(failed().error).title })}</p>}
      </Match>
    </Switch>
  )
}

function WaitButton(props: { readonly state: ConnectWait; readonly canCheck: boolean; readonly onCheck: () => void }) {
  const t = useTranslator(settingsDictionary)
  const label = () => {
    if (props.state.kind === "instructions") return t("settings.machines.connect.ranIt")
    return t(props.state.kind === "checking" ? "settings.machines.connect.checking" : "settings.machines.connect.checkAgain")
  }
  return (
    <Show when={props.state.kind !== "connected"}>
      <Button size="small" variant="neutral" disabled={!props.canCheck || props.state.kind === "checking"} onClick={() => props.onCheck()}>
        {label()}
      </Button>
    </Show>
  )
}

function AnotherMachine() {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const listed = useQuery(() => server.queries.machines.list())
  const wait = createConnectWait(server.machines, knownHostIds(untrack(() => listed.data)))
  const [name, setName] = createSignal(DEFAULT_NAME)
  const chosen = () => name().trim()
  return (
    <Step number="2" title={t("settings.machines.step.another")} description={t("settings.machines.step.another.description")}>
      <TextField label={t("settings.machines.connect.name")} value={name()} onChange={setName} autocomplete="off" />
      <CommandLine command={`claxedo host invite --name ${shellWord(chosen() || DEFAULT_NAME)} --root ~/code`} label={t("settings.machines.copyInvite")} />
      <CommandLine command={CONNECT_COMMAND} label={t("settings.machines.copyConnect")} />
      <div class="settings-inline">
        <WaitButton state={wait.state()} canCheck={chosen() !== ""} onCheck={() => wait.check(chosen())} />
        <WaitLine state={wait.state()} />
      </div>
    </Step>
  )
}

export function ConnectMachineDrawer() {
  const t = useTranslator(settingsDictionary)
  const dialog = useDialog()
  return (
    <Drawer title={t("settings.machines.connect.title")} description={t("settings.machines.connect.description")} closeLabel={t("settings.machines.connect.done")} onClose={() => dialog.close()}>
      <ol class="settings-steps">
        <Step number="1" title={t("settings.machines.step.here")} description={t("settings.machines.step.here.description")} />
        <AnotherMachine />
      </ol>
    </Drawer>
  )
}
