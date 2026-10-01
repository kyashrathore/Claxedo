import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { harnessLabel } from "@/lib/harness-catalog"
import { marketplaceDictionary } from "../i18n"
import type { PersonalEntry } from "../sections"
import { PluginIconTile } from "./plugin-icon"

function PersonalFacts(props: { readonly entry: PersonalEntry; readonly harness: string }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const marketplace = () => (props.entry.kind === "plugin" ? props.entry.marketplace : undefined)
  const kind = () =>
    t(props.entry.kind === "skill" ? "marketplace.personal.kindSkill" : "marketplace.personal.kindPlugin")
  return (
    <dl class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular">
      <dt class="text-text-weak">{t("marketplace.personal.harness")}</dt>
      <dd class="text-text-base">{props.harness}</dd>
      <dt class="text-text-weak">{t("marketplace.personal.kind")}</dt>
      <dd class="text-text-base">{kind()}</dd>
      <Show when={marketplace()}>
        {(value) => (
          <>
            <dt class="text-text-weak">{t("marketplace.personal.marketplace")}</dt>
            <dd class="text-text-base">{value()}</dd>
          </>
        )}
      </Show>
      <dt class="text-text-weak">{t("marketplace.personal.location")}</dt>
      <dd class="break-all text-12-mono text-text-base">{props.entry.root}</dd>
    </dl>
  )
}

export function PersonalDetails(props: { readonly entry: PersonalEntry }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const harness = () =>
    props.entry.harnessId === "agents"
      ? t("marketplace.personal.agentsHarness")
      : (harnessLabel(props.entry.harnessId) ?? props.entry.harnessId)
  const version = () => (props.entry.kind === "plugin" ? props.entry.version : undefined)
  const installedBy = () =>
    version()
      ? t("marketplace.personal.installedByVersion", { version: version() ?? "", harness: harness() })
      : t("marketplace.personal.installedBy", { harness: harness() })
  const manages = () =>
    t(props.entry.kind === "skill" ? "marketplace.personal.managesSkill" : "marketplace.personal.managesPlugin", {
      harness: harness(),
    })
  return (
    <div class="flex h-full min-h-0 flex-col overflow-auto">
      <header class="grid grid-cols-[3rem_1fr] items-start gap-3 border-b border-border-weak-base p-4">
        <PluginIconTile name={props.entry.name} size="pane" />
        <div class="min-w-0">
          <h3 class="truncate text-14-medium text-text-strong">{props.entry.name}</h3>
          <p class="text-12-regular text-text-weak">{installedBy()}</p>
        </div>
      </header>
      <PersonalFacts entry={props.entry} harness={harness()} />
      <p class="px-4 py-3 text-12-regular text-text-weak">{manages()}</p>
    </div>
  )
}
