// The one provider catalog. The command-palette dialog and the onboarding setup
// page both render this, so there is exactly one list with one sort order and
// one set of provider notes — onboarding previously shipped a hardcoded pair of
// buttons that could not reach OAuth providers at all.

import { type Component, Show } from "solid-js"
import { popularProviders, useProviders } from "@/app/providers/use-providers"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/platform/i18n/provider"

export const CUSTOM_PROVIDER_ID = "_custom"

export const ProviderList: Component<{
  harness?: string
  /** Omits the "Custom provider" entry. Onboarding keeps the flow to one decision. */
  hideCustom?: boolean
  onSelect: (providerId: string) => void
}> = (props) => {
  const providers = useProviders(props.harness)
  const language = useLanguage()

  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const showCustom = () => !props.harness && !props.hideCustom
  const note = (id: string) => {
    if (id === "anthropic") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id.startsWith("github-copilot")) return language.t("dialog.provider.copilot.note")
    if (id === "opencode-go") return language.t("dialog.provider.opencodeGo.tagline")
  }

  return (
    <List
      search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
      emptyMessage={language.t("dialog.provider.empty")}
      activeIcon="plus-small"
      key={(x) => x?.id}
      items={() => {
        language.locale()
        return [...(showCustom() ? [{ id: CUSTOM_PROVIDER_ID, name: customLabel() }] : []), ...providers.all().values()]
      }}
      filterKeys={["id", "name"]}
      groupBy={(x) => (popularProviders.includes(x.id) ? popularGroup() : otherGroup())}
      sortBy={(a, b) => {
        if (a.id === CUSTOM_PROVIDER_ID) return -1
        if (b.id === CUSTOM_PROVIDER_ID) return 1
        if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
          return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
        return a.name.localeCompare(b.name)
      }}
      sortGroupsBy={(a, b) => {
        const popular = popularGroup()
        if (a.category === popular && b.category !== popular) return -1
        if (b.category === popular && a.category !== popular) return 1
        return 0
      }}
      onSelect={(x) => {
        if (!x) return
        void providers.load(x.id).catch(() => undefined)
        props.onSelect(x.id)
      }}
    >
      {(i) => (
        <div class="px-1.25 w-full flex items-center gap-x-3">
          <ProviderIcon data-slot="list-item-extra-icon" class="ui-list-item-extra-icon" id={i.id} />
          <span>{i.name}</span>
          <Show when={i.id === "opencode"}>
            <div class="text-14-regular text-text-weak">{language.t("dialog.provider.opencode.tagline")}</div>
          </Show>
          <Show when={i.id === CUSTOM_PROVIDER_ID}>
            <Tag>{language.t("settings.providers.tag.custom")}</Tag>
          </Show>
          <Show when={i.id === "opencode"}>
            <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
          </Show>
          <Show when={note(i.id)}>{(value) => <div class="text-14-regular text-text-weak">{value()}</div>}</Show>
          <Show when={i.id === "opencode-go"}>
            <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}
