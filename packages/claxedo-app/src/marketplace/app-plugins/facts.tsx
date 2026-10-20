import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { MarketplaceKey } from "../i18n"
import { marketplaceDictionary } from "../i18n"
import { CHIP } from "../view/chrome"
import { appPluginUpdate, type AppPluginEntry } from "./model"

function organizationKey(entry: AppPluginEntry): MarketplaceKey {
  if (!entry.install) return "marketplace.app.facts.notInstalled"
  return entry.install.active ? "marketplace.app.facts.installed" : "marketplace.app.facts.turnedOff"
}

export function AppPluginFacts(props: { readonly entry: AppPluginEntry }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const install = () => props.entry.install
  const version = () => {
    const current = install()?.version ?? props.entry.listing?.latest ?? props.entry.manifest.version
    const latest = appPluginUpdate(props.entry)
    return latest ? t("marketplace.app.facts.latest", { version: current, latest }) : current
  }
  return (
    <dl class="grid grid-cols-[5.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 border-b border-border-weak-base px-4 py-3 text-12-regular">
      <dt class="text-text-weaker">{t("marketplace.app.facts.organization")}</dt>
      <dd class="text-text-base">{t(organizationKey(props.entry))}</dd>

      <Show when={install()}>
        {(installed) => (
          <>
            <dt class="text-text-weaker">{t("marketplace.app.facts.forYou")}</dt>
            <dd>
              <span class={CHIP}>{t(installed().active && installed().enabledForMe ? "marketplace.app.facts.on" : "marketplace.app.facts.off")}</span>
            </dd>
            <dt class="text-text-weaker">{t("marketplace.app.facts.default")}</dt>
            <dd class="text-text-base">{t(installed().orgDefault ? "marketplace.app.facts.defaultOn" : "marketplace.app.facts.defaultOff")}</dd>
          </>
        )}
      </Show>

      <dt class="text-text-weaker">{t("marketplace.app.facts.version")}</dt>
      <dd class="text-text-base">{version()}</dd>
    </dl>
  )
}
