import { createEffect, createSignal, Match, Show, Switch } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import { useSecondClock } from "@/lib/clock"
import { useServer, type MintedPairing, type Pairing } from "@/server"
import { Button, ClaxedoIconButton, Drawer, Tabs, useDialog } from "@/ui"
import { settingsDictionary } from "../i18n"
import { codeExpired, codeTimeLeft, createConnectCode, guessedPlatform, stageLineKey, stageLineValues, type CommandPlatform } from "../pairing"
import { PairingRequestCard } from "./pairing-request"
import { SshMachineConnect } from "./machine-ssh"

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

function CommandTabs(props: { readonly minted: MintedPairing }) {
  const t = useTranslator(settingsDictionary)
  const [platform, setPlatform] = createSignal<CommandPlatform>(guessedPlatform(typeof navigator === "object" ? navigator.platform : ""))
  return (
    <Tabs class="settings-connect-method" value={platform()} onChange={(value) => (value === "posix" || value === "windows") && setPlatform(value)}>
      <Tabs.List aria-label={t("settings.machines.connect.platform")}>
        <Tabs.Trigger value="posix">{t("settings.machines.connect.posix")}</Tabs.Trigger>
        <Tabs.Trigger value="windows">{t("settings.machines.connect.windows")}</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="posix" forceMount class="settings-connect-panel">
        <CommandLine command={props.minted.commands.posix} label={t("settings.machines.connect.copy")} />
      </Tabs.Content>
      <Tabs.Content value="windows" forceMount class="settings-connect-panel">
        <CommandLine command={props.minted.commands.windows} label={t("settings.machines.connect.copy")} />
      </Tabs.Content>
    </Tabs>
  )
}

function PairingProgress(props: { readonly minted: MintedPairing; readonly pairing: Pairing | undefined; readonly now: number }) {
  const t = useTranslator(settingsDictionary)
  const waitingForCommand = () => props.pairing?.request === undefined
  const asking = () => (props.pairing?.stage === "awaitingApproval" ? props.pairing : undefined)
  return (
    <Switch>
      <Match when={asking()?.machine}>
        {(machine) => <Show when={asking()}>{(pairing) => <PairingRequestCard pairing={pairing()} machine={machine()} />}</Show>}
      </Match>
      <Match when={props.pairing}>
        {(pairing) => (
          <p class="settings-inline" role="status">
            <span class={pairing().stage === "ready" ? "settings-row-title" : "settings-row-description"}>{t(stageLineKey(pairing().stage), stageLineValues(pairing()))}</span>
            <Show when={waitingForCommand()}>
              <span class="settings-row-description">{t("settings.machines.connect.validFor", { time: codeTimeLeft(props.minted.expiresAt, props.now) })}</span>
            </Show>
          </p>
        )}
      </Match>
    </Switch>
  )
}

function MintedCode(props: { readonly minted: MintedPairing; readonly onExpired: () => void }) {
  const server = useServer()
  const pairing = useQuery(() => server.queries.machines.pairing(props.minted.id))
  const now = useSecondClock(() => pairing.data?.request === undefined)
  createEffect(() => {
    if (codeExpired(props.minted, pairing.data, now())) props.onExpired()
  })
  return (
    <>
      <CommandTabs minted={props.minted} />
      <PairingProgress minted={props.minted} pairing={pairing.data} now={now()} />
    </>
  )
}

function PairingCode() {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  const server = useServer()
  const code = createConnectCode(server.machines)
  const minted = () => {
    const state = code.state()
    return state.kind === "minted" ? state.minted : undefined
  }
  const failure = () => {
    const state = code.state()
    return state.kind === "failed" ? state.error : undefined
  }
  return (
    <Switch fallback={<p class="settings-row-description" role="status">{t("settings.machines.connect.minting")}</p>}>
      <Match when={minted()} keyed>
        {(current) => <MintedCode minted={current} onExpired={code.remint} />}
      </Match>
      <Match when={failure()}>
        {(error) => (
          <div class="settings-inline">
            <p class="settings-note" data-tone="danger" role="alert">{t("settings.machines.connect.mintFailed", { reason: errorCopy(error()).title })}</p>
            <Button size="small" variant="neutral" onClick={() => code.remint()}>{t("settings.machines.connect.retry")}</Button>
          </div>
        )}
      </Match>
    </Switch>
  )
}

export function ConnectMachineDrawer() {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const dialog = useDialog()
  return (
    <Drawer title={t("settings.machines.connect.title")} description={t("settings.machines.connect.description")} closeLabel={t("settings.machines.connect.done")} onClose={() => dialog.close()}>
      <div class="settings-fields">
        <Show when={server.queries.organizations.signedIn} fallback={<p class="settings-row-description">{t("settings.machines.connect.signIn")}</p>}>
          <PairingCode />
          <SshMachineConnect />
        </Show>
        <p class="settings-row-description">{t("settings.machines.connect.thisComputer")}</p>
      </div>
    </Drawer>
  )
}
