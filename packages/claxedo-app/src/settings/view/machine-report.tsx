import { Show } from "solid-js"
import { useTranslator } from "@/i18n"
import type { MachineBlock, MachineEnrollment } from "@/server"
import { settingsDictionary } from "../i18n"
import { blockedKey } from "../machines"
import { CommandLine } from "./command-line"

function FixCommand(props: { readonly name: string; readonly command: string }) {
  const t = useTranslator(settingsDictionary)
  return (
    <>
      <span class="settings-row-description">{t("settings.machines.fix", { name: props.name })}</span>
      <CommandLine command={props.command} label={t("settings.machines.fix.copy")} layout="wrapped" />
    </>
  )
}

export function BlockedNotice(props: { readonly name: string; readonly block: MachineBlock }) {
  const t = useTranslator(settingsDictionary)
  return (
    <section class="settings-machine-report" aria-label={t(blockedKey(props.block))}>
      <p class="settings-note" data-tone="warning" role="status">{t(blockedKey(props.block))}</p>
      <FixCommand name={props.name} command={props.block.fix} />
    </section>
  )
}

export function MachineFacts(props: { readonly name: string; readonly enrollment: MachineEnrollment }) {
  const t = useTranslator(settingsDictionary)
  const system = () => [props.enrollment.os, props.enrollment.arch].filter((part): part is string => !!part).join(" · ")
  return (
    <section class="settings-machine-report">
      <Show when={props.enrollment.cliVersion}>
        {(version) => (
          <p class="settings-inline">
            <span class="settings-row-title">{t("settings.machines.cli", { version: version() })}</span>
            <Show when={props.enrollment.update}>
              <span class="settings-note" data-tone="warning">{t("settings.machines.update")}</span>
            </Show>
          </p>
        )}
      </Show>
      <Show when={system()}>{(text) => <span class="settings-row-description">{text()}</span>}</Show>
      <Show when={props.enrollment.update}>{(update) => <FixCommand name={props.name} command={update().command} />}</Show>
    </section>
  )
}
