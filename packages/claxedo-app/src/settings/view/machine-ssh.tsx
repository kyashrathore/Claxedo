import { For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useServer, type MintedPairing } from "@/server"
import { Button, TextField } from "@/ui"
import { settingsDictionary } from "../i18n"
import { stageLineKey, stageLineValues } from "../pairing"
import { type SshBridge, type SshHostKey, type SshInstallStep, type SshTarget } from "../ssh-bridge"
import { createSshConnect, sshFailureKey, sshHost, type SshConnect, type SshConnectFailure } from "../ssh-connect"
import { PairingRequestCard } from "./pairing-request"

type Draft = { destination: string; port: string; identityFile: string; folder: string }

type Flow = ReturnType<typeof createSshConnect>

function targetFromDraft(draft: Draft): SshTarget {
  const trimmed = { identityFile: draft.identityFile.trim(), folder: draft.folder.trim(), port: draft.port.trim() }
  return {
    destination: draft.destination.trim(),
    ...(trimmed.port ? { port: Number(trimmed.port) } : {}),
    ...(trimmed.identityFile ? { identityFile: trimmed.identityFile } : {}),
    ...(trimmed.folder ? { folder: trimmed.folder } : {}),
  }
}

function SshForm(props: { readonly draft: Draft; readonly setDraft: SetStoreFunction<Draft>; readonly busy: boolean; readonly onSubmit: () => void }) {
  const t = useTranslator(settingsDictionary)
  return (
    <form class="settings-fields" onSubmit={(event) => { event.preventDefault(); props.onSubmit() }}>
      <TextField label={t("settings.machines.ssh.destination")} placeholder="user@host" autocomplete="off" spellcheck={false} value={props.draft.destination} onChange={(value) => props.setDraft("destination", value)} />
      <div class="settings-ssh-options">
        <TextField label={t("settings.machines.ssh.port")} placeholder="22" inputMode="numeric" value={props.draft.port} onChange={(value) => props.setDraft("port", value)} />
        <TextField label={t("settings.machines.ssh.identity")} placeholder={t("settings.machines.ssh.identityPlaceholder")} spellcheck={false} value={props.draft.identityFile} onChange={(value) => props.setDraft("identityFile", value)} />
      </div>
      <TextField label={t("settings.machines.ssh.folder")} placeholder={t("settings.machines.ssh.folderPlaceholder")} spellcheck={false} value={props.draft.folder} onChange={(value) => props.setDraft("folder", value)} />
      <div class="settings-inline">
        <Button type="submit" size="small" variant="contrast" disabled={props.busy || !props.draft.destination.trim()}>{t("settings.machines.ssh.connect")}</Button>
      </div>
    </form>
  )
}

function HostKeyPrompt(props: { readonly host: string; readonly keys: readonly SshHostKey[]; readonly onTrust: () => void; readonly onCancel: () => void }) {
  const t = useTranslator(settingsDictionary)
  return (
    <section class="settings-pairing-request" aria-label={t("settings.machines.ssh.hostKeyTitle", { host: props.host })}>
      <span class="settings-row-title">{t("settings.machines.ssh.hostKeyTitle", { host: props.host })}</span>
      <span class="settings-row-description">{t("settings.machines.ssh.hostKey")}</span>
      <For each={props.keys}>{(key) => <code class="settings-ssh-fingerprint">{`${key.fingerprint} (${key.type})`}</code>}</For>
      <div class="settings-inline settings-pairing-answers">
        <Button size="small" variant="outline" onClick={() => props.onCancel()}>{t("settings.machines.ssh.cancel")}</Button>
        <Button size="small" variant="contrast" onClick={() => props.onTrust()}>{t("settings.machines.ssh.trust")}</Button>
      </div>
    </section>
  )
}

function FailureLine(props: { readonly failure: SshConnectFailure; readonly target: SshTarget }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  const text = () => {
    const failed = props.failure
    if (failed.kind === "mint") return t("settings.machines.connect.mintFailed", { reason: errorCopy(failed.error).title })
    if (failed.failure.reason === "remote" && failed.failure.line) return failed.failure.line
    return t(sshFailureKey(failed.failure), { host: sshHost(props.target), os: failed.failure.os ?? "", folder: props.target.folder ?? "~" })
  }
  return <p class="settings-note" data-tone="danger" role="alert">{text()}</p>
}

function SshPairing(props: { readonly minted: MintedPairing }) {
  const t = useTranslator(settingsDictionary)
  const server = useServer()
  const pairing = useQuery(() => server.queries.machines.pairing(props.minted.id))
  const shown = () => (pairing.data && pairing.data.stage !== "waiting" && pairing.data.stage !== "installing" ? pairing.data : undefined)
  return (
    <Show when={shown()}>
      {(current) => (
        <Show when={current().stage === "awaitingApproval" ? current().machine : undefined} fallback={<p class="settings-row-title" role="status">{t(stageLineKey(current().stage), stageLineValues(current()))}</p>}>
          {(machine) => <PairingRequestCard pairing={current()} machine={machine()} />}
        </Show>
      )}
    </Show>
  )
}

function SshInstall(props: { readonly target: SshTarget; readonly minted: MintedPairing; readonly steps: readonly SshInstallStep[]; readonly finished: boolean }) {
  const t = useTranslator(settingsDictionary)
  return (
    <div class="settings-fields" role="status">
      <span class="settings-row-description">{t(props.finished ? "settings.machines.ssh.installed" : "settings.machines.ssh.installing", { host: sshHost(props.target) })}</span>
      <ol class="settings-ssh-steps">
        <For each={props.steps}>{(step) => <li>{`${step.index}/${step.total} ${step.title}`}</li>}</For>
      </ol>
      <SshPairing minted={props.minted} />
    </div>
  )
}

function SshStatus(props: { readonly state: SshConnect; readonly flow: Flow }) {
  const t = useTranslator(settingsDictionary)
  const line = (key: "settings.machines.ssh.checking" | "settings.machines.connect.minting", target: SshTarget) => <p class="settings-row-description" role="status">{t(key, { host: sshHost(target) })}</p>
  return (
    <Switch>
      <Match when={props.state.kind === "checking" || props.state.kind === "trusting" ? props.state : undefined}>{(state) => line("settings.machines.ssh.checking", state().target)}</Match>
      <Match when={props.state.kind === "minting" ? props.state : undefined}>{(state) => line("settings.machines.connect.minting", state().target)}</Match>
      <Match when={props.state.kind === "confirmingHost" ? props.state : undefined}>
        {(state) => <HostKeyPrompt host={sshHost(state().target)} keys={state().keys} onTrust={() => void props.flow.trust()} onCancel={() => props.flow.edit()} />}
      </Match>
      <Match when={props.state.kind === "failed" ? props.state : undefined}>{(state) => <FailureLine failure={state().failure} target={state().target} />}</Match>
    </Switch>
  )
}

function SshConnectFlow(props: { readonly bridge: SshBridge }) {
  const server = useServer()
  const flow = createSshConnect(props.bridge, server.machines)
  onCleanup(flow.dispose)
  const [draft, setDraft] = createStore<Draft>({ destination: "", port: "", identityFile: "", folder: "" })
  const running = () => {
    const state = flow.state()
    return state.kind === "installing" || state.kind === "installed" ? state : undefined
  }
  const busy = () => !["editing", "failed"].includes(flow.state().kind)
  return (
    <Show when={running()} fallback={<><SshForm draft={draft} setDraft={setDraft} busy={busy()} onSubmit={() => void flow.connect(targetFromDraft(draft))} /><SshStatus state={flow.state()} flow={flow} /></>}>
      {(state) => <SshInstall target={state().target} minted={state().minted} steps={state().steps} finished={state().kind === "installed"} />}
    </Show>
  )
}

export function SshMachineConnect(props: { readonly bridge: SshBridge }) {
  const t = useTranslator(settingsDictionary)
  return (
    <>
      <p class="settings-row-description">{t("settings.machines.ssh.intro")}</p>
      <SshConnectFlow bridge={props.bridge} />
    </>
  )
}
