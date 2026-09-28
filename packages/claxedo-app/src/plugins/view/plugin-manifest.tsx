import { createSignal, For, Show, type JSX } from "solid-js"
import { copyText } from "@/lib/clipboard"
import { formatDateTimeMed } from "@/lib/relative-time"
import { useI18n } from "@/i18n"
import { ClaxedoIconButton, showToast } from "@/ui"
import { failureReason } from "../failure"
import { usePluginsText, type PluginsKey } from "../i18n"
import type { PluginSummary } from "../model"

function Entry(props: { readonly label: PluginsKey; readonly values: readonly string[]; readonly code?: boolean }): JSX.Element {
  const t = usePluginsText()
  return (
    <div class="plugin-manifest-entry">
      <dt>{t(props.label)}</dt>
      <Show when={props.values.length > 0} fallback={<dd>{t("plugins.manifest.none")}</dd>}>
        <For each={props.values}>{(value) => <dd>{props.code ? <code>{value}</code> : value}</dd>}</For>
      </Show>
    </div>
  )
}

function FolderEntry(props: { readonly directory: string }): JSX.Element {
  const t = usePluginsText()
  const [copied, setCopied] = createSignal(false)
  const copy = () =>
    void copyText(props.directory).then((result) => {
      if (result.copied) return setCopied(true)
      showToast({ variant: "error", description: t("plugins.manifest.copyFailed", { reason: failureReason(result.error) }) })
    })
  return (
    <div class="plugin-manifest-entry">
      <dt>{t("plugins.manifest.folder")}</dt>
      <dd class="plugin-manifest-folder">
        <code>{props.directory}</code>
        <ClaxedoIconButton icon={copied() ? "check" : "copy"} size="small" variant="ghost" aria-label={t("plugins.manifest.copyFolder")} onClick={copy} />
      </dd>
    </div>
  )
}

export function PluginManifestSummary(props: { readonly plugin: PluginSummary }): JSX.Element {
  const i18n = useI18n()
  const builtAt = () => {
    const at = props.plugin.origin.builtAt
    return at ? [formatDateTimeMed(Date.parse(at), i18n.intlTag())] : []
  }
  return (
    <dl class="plugin-manifest" aria-label={props.plugin.name}>
      <Entry label="plugins.manifest.name" values={[props.plugin.name]} />
      <Entry label="plugins.manifest.id" values={[props.plugin.id]} code />
      <Entry label="plugins.manifest.version" values={[props.plugin.version]} />
      <FolderEntry directory={props.plugin.origin.directory} />
      <Entry label="plugins.manifest.routes" values={props.plugin.manifest.server.routes} code />
      <Entry label="plugins.manifest.operations" values={props.plugin.manifest.server.operations} code />
      <Entry label="plugins.manifest.requires" values={props.plugin.manifest.requires} />
      <Entry label="plugins.manifest.build" values={[props.plugin.origin.hash]} code />
      <Entry label="plugins.manifest.builtAt" values={builtAt()} />
    </dl>
  )
}
