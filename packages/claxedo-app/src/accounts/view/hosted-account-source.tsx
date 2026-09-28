import { useQuery } from "@tanstack/solid-query"
import { createSignal, For, Show } from "solid-js"
import { toAppError, useServer, type AccountSource, type HostedAccountSources } from "@/server"
import { RadioGroup, RadioItem, showToast } from "@/ui"
import { useAccountsText } from "../i18n"

const SOURCES: readonly AccountSource[] = ["own", "team"]

const SOURCE_KEY = { own: "settings.providers.accountSource.own", team: "settings.providers.accountSource.team" } as const

export function createHostedAccountSources(harness: () => string) {
  const server = useServer()
  const t = useAccountsText()
  const enabled = () => harness() === "pi" && server.capabilities() !== undefined && server.capabilities()?.thisMachine === undefined
  const query = useQuery(() => ({ ...server.queries.accounts.hostedSources(harness()), enabled: enabled() }))
  const [writing, setWriting] = createSignal<string>()
  const choose = async (providerId: string, source: AccountSource) => {
    setWriting(providerId)
    try {
      await server.accounts.setHostedSource(harness(), providerId, source)
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    } finally {
      setWriting(undefined)
    }
  }
  const sources = (): HostedAccountSources | undefined => (enabled() ? query.data : undefined)
  return {
    error: () => (enabled() && query.error ? toAppError(query.error).message : undefined),
    source: (providerId: string): AccountSource => sources()?.sources.get(providerId) ?? "own",
    teamHeld: (providerId: string) => sources()?.team.has(providerId) === true,
    offered: (providerId: string) => sources() !== undefined && (sources()?.team.has(providerId) === true || sources()?.sources.get(providerId) === "team"),
    writing,
    choose: (providerId: string, source: AccountSource) => void choose(providerId, source),
  }
}

export type HostedAccountSourceChoices = ReturnType<typeof createHostedAccountSources>

export function HostedAccountSourceChoice(props: { readonly providerId: string; readonly providerName: string; readonly sources: HostedAccountSourceChoices }) {
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
            const chosen = SOURCES.find((candidate) => candidate === value)
            if (chosen && chosen !== source()) props.sources.choose(props.providerId, chosen)
          }}
        >
          <For each={SOURCES}>{(option) => <RadioItem value={option} label={t(SOURCE_KEY[option])} />}</For>
        </RadioGroup>
        <Show when={source() === "team" && !props.sources.teamHeld(props.providerId)}>
          <p class="text-12-regular text-text-weak" role="alert">
            {t("settings.providers.accountSource.unavailable", { name: props.providerName })}
          </p>
        </Show>
      </div>
    </Show>
  )
}
