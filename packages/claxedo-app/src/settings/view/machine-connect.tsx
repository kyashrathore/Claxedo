import { createEffect, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useSecondClock } from "@/lib/clock"
import { desktopBridge } from "@/lib/desktop-bridge"
import { useServer, type MintedPairing, type Pairing } from "@/server"
import { Button, Drawer, SegmentedControl, SegmentedControlItem, Tabs, useDialog } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { codeExpired, codeTimeLeft, createConnectCode, guessedPlatform, stageLineKey, stageLineValues, type CommandPlatform } from "../pairing"
import { readSshBridge } from "../ssh-bridge"
import { CommandLine } from "./command-line"
import { PairingRequestCard } from "./pairing-request"
import { ServerConnect } from "./server-connect"
import { SshMachineConnect } from "./machine-ssh"
import "./settings.css"

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

type ConnectWay = "paste" | "ssh" | "server"

const WAY_LABELS = {
  paste: "settings.machines.connect.way.paste",
  ssh: "settings.machines.connect.way.ssh",
  server: "settings.machines.connect.way.server",
} as const satisfies Record<ConnectWay, SettingsKey>

const isConnectWay = (value: string): value is ConnectWay => Object.hasOwn(WAY_LABELS, value)

function WayPanel(props: { readonly way: ConnectWay; readonly chosen: ConnectWay; readonly opened: ReadonlySet<ConnectWay>; readonly children: JSX.Element }) {
  const t = useTranslator(settingsDictionary)
  return (
    <section class="settings-connect-way" hidden={props.chosen !== props.way} aria-label={t(WAY_LABELS[props.way])}>
      <Show when={props.opened.has(props.way)}>{props.children}</Show>
    </section>
  )
}

function ConnectWays() {
  const t = useTranslator(settingsDictionary)
  const ssh = readSshBridge()
  const ways: readonly ConnectWay[] = ssh ? ["paste", "ssh", "server"] : ["paste", "server"]
  const [chosen, setChosen] = createSignal<ConnectWay>("paste")
  const [opened, setOpened] = createSignal<ReadonlySet<ConnectWay>>(new Set(["paste"]))
  const choose = (way: ConnectWay) => {
    setChosen(way)
    setOpened((current) => new Set([...current, way]))
  }
  return (
    <>
      <SegmentedControl class="segmented-control-v2--fit" aria-label={t("settings.machines.connect.how")} value={chosen()} onChange={(value) => value !== null && isConnectWay(value) && choose(value)}>
        <For each={ways}>{(way) => <SegmentedControlItem value={way}>{t(WAY_LABELS[way])}</SegmentedControlItem>}</For>
      </SegmentedControl>
      <WayPanel way="paste" chosen={chosen()} opened={opened()}>
        <p class="settings-row-description">{t("settings.machines.connect.description")}</p>
        <PairingCode />
      </WayPanel>
      <Show when={ssh}>
        {(bridge) => (
          <WayPanel way="ssh" chosen={chosen()} opened={opened()}>
            <SshMachineConnect bridge={bridge()} />
          </WayPanel>
        )}
      </Show>
      <WayPanel way="server" chosen={chosen()} opened={opened()}>
        <ServerConnect />
      </WayPanel>
    </>
  )
}

export function ConnectMachineDrawer() {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const dialog = useDialog()
  const signedIn = () => server.queries.organizations.signedIn
  return (
    <Drawer title={t("settings.machines.connect.title")} description={signedIn() ? t("settings.machines.connect.how") : undefined} closeLabel={t("settings.machines.connect.done")} onClose={() => dialog.close()}>
      <div class="settings-fields">
        <Show when={signedIn()} fallback={<p class="settings-row-description">{t("settings.machines.connect.signIn")}</p>}>
          <ConnectWays />
        </Show>
        <Show when={!desktopBridge()}>
          <p class="settings-row-description">{t("settings.machines.connect.thisComputer")}</p>
        </Show>
      </div>
    </Drawer>
  )
}
