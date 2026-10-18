import { ACCOUNT_SOURCES } from "@claxedo/account-contract/vocabulary"
import { For, Show } from "solid-js"
import { RadioGroup, RadioItem } from "@/ui"
import { useAccountsText } from "../i18n"
import type { CatalogAccountSourceChoices } from "../catalog-account-sources"

const SOURCE_KEY = { own: "settings.providers.accountSource.own", org: "settings.providers.accountSource.org" } as const

export function CatalogAccountSourceChoice(props: { readonly providerId: string; readonly providerName: string; readonly sources: CatalogAccountSourceChoices }) {
  const t = useAccountsText()
  const source = () => props.sources.source(props.providerId)
  return (
    <Show when={props.sources.offered(props.providerId)}>
      <div class="flex flex-col items-start gap-1.5 pb-3 pl-8">
        <RadioGroup
          name={`account-source-${props.providerId}`}
          aria-label={t("settings.providers.accountSource.label", { name: props.providerName })}
          value={source()}
          disabled={props.sources.writing() !== undefined}
          onChange={(value: string) => {
            const chosen = ACCOUNT_SOURCES.find((candidate) => candidate === value)
            if (chosen && chosen !== source()) props.sources.choose(props.providerId, chosen)
          }}
        >
          <For each={ACCOUNT_SOURCES}>{(option) => <RadioItem value={option} label={t(SOURCE_KEY[option])} />}</For>
        </RadioGroup>
        <Show when={source() === "org" && !props.sources.orgHeld(props.providerId)}>
          <p class="text-12-regular text-text-weak" role="alert">
            {t("settings.providers.accountSource.unavailable", { name: props.providerName })}
          </p>
        </Show>
      </div>
    </Show>
  )
}
