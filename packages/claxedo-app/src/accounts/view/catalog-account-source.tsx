import { ACCOUNT_SOURCES, type AccountSource } from "@claxedo/account-contract/vocabulary"
import { useQuery } from "@tanstack/solid-query"
import { createSignal, For, Show } from "solid-js"
import { piProviderAccountIds, toAppError, useServer } from "@/server"
import { RadioGroup, RadioItem, showToast } from "@/ui"
import { useAccountsText } from "../i18n"

const SOURCE_KEY = { own: "settings.providers.accountSource.own", org: "settings.providers.accountSource.org" } as const

export function createCatalogAccountSources(harness: () => string, refreshCatalog: () => Promise<unknown>) {
  const server = useServer()
  const t = useAccountsText()
  const enabled = () => harness() === "pi" && server.capabilities() !== undefined
  const query = useQuery(() => ({ ...server.queries.accounts.sources(), enabled: enabled() }))
  const [writing, setWriting] = createSignal<string>()
  const read = () => (enabled() ? query.data : undefined)
  const source = (providerId: string): AccountSource => {
    const ids = piProviderAccountIds(providerId)
    return ids.length > 0 && ids.every((id) => read()?.sources.get(id) === "org") ? "org" : "own"
  }
  const orgHeld = (providerId: string) => read()?.org.some((row) => piProviderAccountIds(providerId).includes(row.providerId)) === true
  const choose = async (providerId: string, chosen: AccountSource) => {
    setWriting(providerId)
    try {
      await server.accounts.setSource(piProviderAccountIds(providerId), chosen)
      await refreshCatalog()
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    } finally {
      setWriting(undefined)
    }
  }
  return {
    error: () => (enabled() && query.error ? toAppError(query.error).message : undefined),
    source,
    orgHeld,
    offered: (providerId: string) => read() !== undefined && (orgHeld(providerId) || source(providerId) === "org"),
    writing,
    choose: (providerId: string, chosen: AccountSource) => void choose(providerId, chosen),
  }
}

export type CatalogAccountSourceChoices = ReturnType<typeof createCatalogAccountSources>

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
