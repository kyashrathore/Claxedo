import { createSignal, For, Show } from "solid-js"
import { useErrorCopy, useTranslator, type DomainTranslate } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import type { AppError, Machine } from "@/server"
import { Button } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { adviceKey, checkedMachine, checkError, headlineKey, hopsOf, type Hop, type HopStatus, type MachineCheck } from "../machines"
import { useRelativeAge } from "./machine-status"

const STATUS_KEY = {
  checking: "settings.machines.hop.checking",
  works: "settings.machines.hop.works",
  failed: "settings.machines.hop.failed",
  notChecked: "settings.machines.hop.notChecked",
} as const satisfies Record<HopStatus, SettingsKey>

const STATUS_TONE = { checking: "muted", works: "success", failed: "danger", notChecked: "muted" } as const satisfies Record<HopStatus, string>

const HOP_LABEL = {
  claxedo: "settings.machines.hop.claxedo",
  machine: "settings.machines.hop.machine",
  runtime: "settings.machines.hop.runtime",
} as const satisfies Record<Hop["id"], SettingsKey>

type Words = { readonly t: DomainTranslate<SettingsKey>; readonly reason: (error: AppError) => string; readonly lastSeen: string | undefined }

function machineHopDetail(check: MachineCheck, words: Words): string | undefined {
  const reason = check.kind === "finished" && check.verdict.failing === "machine" ? check.verdict.reason : undefined
  if (reason === "removed") return words.t("settings.machines.hop.removed")
  if (reason === "paused") return words.t("settings.machines.paused")
  return words.lastSeen ? words.t("settings.machines.hop.checkedIn", { time: words.lastSeen }) : undefined
}

function runtimeHopDetail(check: MachineCheck, words: Words): string | undefined {
  if (check.kind !== "finished") return undefined
  const { verdict } = check
  if (verdict.failing === "none") return verdict.probe.kind === "servesNothing" ? words.t("settings.machines.hop.servesNothing") : undefined
  if (verdict.failing !== "runtime") return undefined
  return verdict.probe.kind === "unhealthy" ? words.t("settings.machines.hop.unhealthy") : words.reason(verdict.probe.error)
}

function hopDetail(hop: Hop, check: MachineCheck, words: Words): string | undefined {
  if (hop.id === "machine") return machineHopDetail(check, words)
  if (hop.id === "runtime") return runtimeHopDetail(check, words)
  const error = hop.status === "failed" ? checkError(check) : undefined
  return error ? words.reason(error) : undefined
}

function factLines(check: MachineCheck, machine: Machine | undefined): string[] {
  const error = checkError(check)
  const enrollment = machine?.enrollment
  return [
    ...(machine ? [`State: ${machine.paused ? "paused" : machine.online ? "online" : "offline"}`] : []),
    ...(enrollment ? [`Last check-in: ${new Date(enrollment.lastSeenAt).toISOString()}`, `Folders served: ${enrollment.servingWorkspaceIds.length}`] : []),
    ...(error ? [`Error: ${[error.class, error.code, error.status].filter((part) => part !== undefined).join(" ")}`] : []),
    ...(check.kind === "finished" ? [`Checked: ${new Date(check.checkedAt).toISOString()} (attempt ${check.attempt})`] : []),
  ]
}

function diagnosticsText(input: { readonly name: string; readonly check: MachineCheck; readonly words: Words }): string {
  const { t } = input.words
  const hops = hopsOf(input.check).map((hop) => {
    const detail = hopDetail(hop, input.check, input.words)
    return `${t(HOP_LABEL[hop.id], { name: input.name })}: ${t(STATUS_KEY[hop.status])}${detail ? ` (${detail})` : ""}`
  })
  const advice = adviceKey(input.check)
  return [
    `${t("settings.machines.check.title")}: ${input.name}`,
    t(headlineKey(input.check), { name: input.name }),
    ...hops,
    ...(advice ? [t(advice, { name: input.name })] : []),
    ...factLines(input.check, checkedMachine(input.check)),
  ].join("\n")
}

function HopRow(props: { readonly hop: Hop; readonly label: string; readonly detail: string | undefined }) {
  const t = useTranslator(settingsDictionary)
  return (
    <li class="settings-hop" data-status={props.hop.status}>
      <span class="settings-dot" data-tone={STATUS_TONE[props.hop.status]} aria-hidden="true" />
      <span class="settings-hop-text">
        <span class="settings-row-title">{props.label}</span>
        <Show when={props.detail}>{(detail) => <span class="settings-row-description">{detail()}</span>}</Show>
      </span>
      <span class="settings-row-description">{t(STATUS_KEY[props.hop.status])}</span>
    </li>
  )
}

function CopyDiagnostics(props: { readonly text: () => string }) {
  const t = useTranslator(settingsDictionary)
  const [copied, setCopied] = createSignal(false)
  const copy = () => void copyText(props.text()).then((result) => setCopied(result.copied))
  return (
    <Button size="small" variant="ghost" onClick={copy}>
      {t(copied() ? "settings.machines.check.copied" : "settings.machines.check.copy")}
    </Button>
  )
}

export function CheckReport(props: { readonly check: MachineCheck; readonly name: string; readonly onRetry: () => void }) {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  const lastSeen = useRelativeAge(() => checkedMachine(props.check)?.enrollment?.lastSeenAt)
  const words = (): Words => ({ t, reason: (error) => errorCopy(error).title, lastSeen: lastSeen() })
  const advice = () => adviceKey(props.check)
  return (
    <section class="settings-machine-check" aria-label={t("settings.machines.check.label")}>
      <p class="settings-machine-headline" role="status">{t(headlineKey(props.check), { name: props.name })}</p>
      <Show when={advice()}>{(key) => <p class="settings-row-description">{t(key(), { name: props.name })}</p>}</Show>
      <ol class="settings-hops">
        <For each={hopsOf(props.check)}>
          {(hop) => <HopRow hop={hop} label={t(HOP_LABEL[hop.id], { name: props.name })} detail={hopDetail(hop, props.check, words())} />}
        </For>
      </ol>
      <div class="settings-inline">
        <Button size="small" variant="neutral" disabled={props.check.kind !== "finished"} onClick={() => props.onRetry()}>
          {t("settings.machines.check.retry")}
        </Button>
        <CopyDiagnostics text={() => diagnosticsText({ name: props.name, check: props.check, words: words() })} />
      </div>
    </section>
  )
}
