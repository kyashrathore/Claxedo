import { For, Show, type JSX } from "solid-js"
import { Button, Dialog, showToast, type useDialog } from "@/ui"
import type { AccessChange, ApprovalCheck, PluginAccess } from "../approval"
import type { PluginHost } from "../host"
import { usePluginsText, type PluginsKey, type PluginsText } from "../i18n"
import type { PluginSummary } from "../model"
import { PluginManifestSummary } from "./plugin-manifest"
import { PluginWarning } from "./plugin-warning"

export type ApprovalRequest = {
  readonly host: PluginHost
  readonly dialog: ReturnType<typeof useDialog>
  readonly t: PluginsText
}

function titleKey(check: ApprovalCheck): PluginsKey {
  if (check.kind === "accessChanged") return "plugins.approval.access"
  if (check.kind === "codeChanged") return "plugins.approval.code"
  return "plugins.approval.new"
}

function accessLines(t: PluginsText, access: PluginAccess): readonly string[] {
  return [
    ...access.routes.map((value) => t("plugins.approval.route", { value })),
    ...access.operations.map((value) => t("plugins.approval.operation", { value })),
    ...access.requires.map((value) => t("plugins.approval.requires", { value })),
  ]
}

function ChangeList(props: { readonly label: PluginsKey; readonly lines: readonly string[] }): JSX.Element {
  const t = usePluginsText()
  return (
    <Show when={props.lines.length > 0}>
      <div class="plugin-approval-change">
        <p class="plugin-approval-change-label">{t(props.label)}</p>
        <ul>
          <For each={props.lines}>{(line) => <li>{line}</li>}</For>
        </ul>
      </div>
    </Show>
  )
}

function AccessChanges(props: { readonly change: AccessChange }): JSX.Element {
  const t = usePluginsText()
  return (
    <section class="plugin-approval-changes" aria-label={t("plugins.approval.added")}>
      <ChangeList label="plugins.approval.added" lines={accessLines(t, props.change.added)} />
      <ChangeList label="plugins.approval.removed" lines={accessLines(t, props.change.removed)} />
    </section>
  )
}

function ApprovalDialog(props: { readonly plugin: PluginSummary; readonly decide: (approved: boolean) => void }): JSX.Element {
  const t = usePluginsText()
  const change = () => (props.plugin.approval.kind === "accessChanged" ? props.plugin.approval.change : undefined)
  return (
    <Dialog title={t(titleKey(props.plugin.approval), { name: props.plugin.name })} fit>
      <div class="plugin-approval">
        <PluginWarning />
        <Show when={change()}>{(accessChange) => <AccessChanges change={accessChange()} />}</Show>
        <PluginManifestSummary plugin={props.plugin} />
        <div class="plugin-approval-actions">
          <Button type="button" variant="ghost" onClick={() => props.decide(false)}>
            {t("plugins.cancel")}
          </Button>
          <Button type="button" variant="primary" onClick={() => props.decide(true)}>
            {t("plugins.approval.accept")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function requestApproval(input: ApprovalRequest, plugin: PluginSummary): void {
  if (plugin.origin.kind !== "live") return
  const hash = plugin.origin.hash
  const decide = (approved: boolean) => {
    input.dialog.close()
    if (!approved) return
    if (!input.host.approve(plugin.id, hash)) return void showToast({ variant: "error", description: input.t("plugins.approval.stale", { name: plugin.name }) })
    input.host.switchOn(plugin.id)
  }
  void input.dialog.show(() => <ApprovalDialog plugin={plugin} decide={decide} />)
}
