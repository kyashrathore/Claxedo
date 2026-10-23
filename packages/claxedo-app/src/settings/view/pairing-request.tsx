import { createSignal, Show } from "solid-js"
import { useErrorCopy, useI18n, useTranslator } from "@/i18n"
import { useAgeClock } from "@/lib/clock"
import { formatRelativeTime } from "@/lib/relative-time"
import { toAppError, useServer, type Pairing, type PairingMachine } from "@/server"
import { Button, TextField } from "@/ui"
import { getFilename } from "@/ui/utils"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { machineActions, type PairingAnswer } from "../machines"

const FAILED_KEY = {
  approve: "settings.machines.approve.failed",
  deny: "settings.machines.deny.failed",
} as const satisfies Record<PairingAnswer, SettingsKey>

const WIDE_FOLDER_KEY = {
  home: "settings.machines.approve.home",
  root: "settings.machines.approve.root",
} as const satisfies Partial<Record<PairingMachine["folderKind"], SettingsKey>>

function AskedLine(props: { readonly machine: PairingMachine; readonly askedAt: number | undefined }) {
  const t = useTranslator(settingsDictionary)
  const i18n = useI18n()
  const now = useAgeClock(() => props.askedAt)
  const facts = () => {
    const parts = [props.machine.os, props.machine.arch, props.machine.country].filter((part): part is string => !!part)
    const asked = props.askedAt === undefined ? [] : [t("settings.machines.approve.asked", { age: formatRelativeTime(props.askedAt, i18n.intlTag(), now()) })]
    return [...parts, ...asked].join(" · ")
  }
  return <span class="settings-row-description">{facts()}</span>
}

function FolderLine(props: { readonly machine: PairingMachine }) {
  const t = useTranslator(settingsDictionary)
  const wide = () => (props.machine.folderKind === "folder" ? undefined : WIDE_FOLDER_KEY[props.machine.folderKind])
  return (
    <>
      <span class="settings-pairing-folder">
        <span class="settings-row-description">{t("settings.machines.approve.folder")}</span>
        <code>{props.machine.folder}</code>
        <span class="settings-row-description">({t("settings.machines.approve.where")})</span>
      </span>
      <Show when={wide()}>{(key) => <p class="settings-note" data-tone="warning" role="note">{t(key())}</p>}</Show>
    </>
  )
}

export function PairingRequestCard(props: { readonly pairing: Pairing; readonly machine: PairingMachine }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  const server = useServer()
  const actions = machineActions<PairingAnswer>()
  const [name, setName] = createSignal(props.machine.hostname)
  const isFolderRequest = () => props.pairing.request === "folder"
  const machineName = () => props.pairing.name ?? props.machine.hostname
  const title = () => isFolderRequest()
    ? t("settings.machines.approve.folderTitle", { folder: getFilename(props.machine.folder) || props.machine.folder, name: machineName() })
    : t("settings.machines.approve.title", { name: props.machine.hostname })
  const busy = () => actions.state().kind === "working"
  const failure = () => {
    const state = actions.state()
    return state.kind === "failed" ? state : undefined
  }
  const answer = async (action: PairingAnswer) => {
    actions.send({ type: "started", action })
    try {
      if (action === "deny") await server.machines.deny(props.pairing.id)
      else await server.machines.approve(props.pairing.id, isFolderRequest() ? undefined : name().trim() || undefined)
    } catch (error) {
      return actions.send({ type: "failed", error: toAppError(error) })
    }
    actions.send({ type: "succeeded" })
  }
  return (
    <section class="settings-pairing-request" aria-label={title()}>
      <span class="settings-row-title">{title()}</span>
      <AskedLine machine={props.machine} askedAt={props.pairing.askedAt} />
      <Show when={!isFolderRequest()}>
        <TextField label={t("settings.machines.approve.name")} value={name()} onChange={setName} autocomplete="off" />
      </Show>
      <FolderLine machine={props.machine} />
      <Show when={failure()}>
        {(failed) => <p class="settings-note" data-tone="danger" role="alert">{t(FAILED_KEY[failed().action], { name: machineName(), reason: errorCopy(failed().error).title })}</p>}
      </Show>
      <div class="settings-inline settings-pairing-answers">
        <Button size="small" variant="outline" disabled={busy()} onClick={() => void answer("deny")}>{t("settings.machines.deny")}</Button>
        <Button size="small" variant="contrast" disabled={busy()} onClick={() => void answer("approve")}>{t("settings.machines.approve")}</Button>
      </div>
    </section>
  )
}
