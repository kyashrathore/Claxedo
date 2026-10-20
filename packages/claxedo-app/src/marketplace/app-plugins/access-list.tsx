import { For, type JSX } from "solid-js"
import type { PluginManifest } from "@claxedo/plugin-api"
import { useTranslator } from "@/i18n"
import { Icon } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { HEADING } from "../view/chrome"
import { appPluginAccess } from "./model"

export function AppPluginAccessList(props: { readonly manifest: PluginManifest; readonly heading?: "section" | "field" }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <section class="flex flex-col gap-2" aria-label={t("marketplace.app.access")}>
      <h3 class={props.heading === "field" ? "text-13-medium text-text-strong" : HEADING}>{t("marketplace.app.access")}</h3>
      <ul class="flex flex-col gap-1.5">
        <For each={appPluginAccess(props.manifest)}>
          {(line) => (
            <li class="flex items-start gap-2 text-12-regular text-text-base">
              <span class="mt-0.5 text-icon-weak-base">
                <Icon name="check" size="small" />
              </span>
              <span class="min-w-0 break-words">{t(line.key, line.params)}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
