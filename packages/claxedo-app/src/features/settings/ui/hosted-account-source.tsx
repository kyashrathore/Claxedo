import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { showToast } from "@opencode-ai/ui/toast"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createSignal, Show, type Component } from "solid-js"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import {
  getHostedAccountSources,
  putHostedAccountSource,
  type AccountSource,
} from "@/platform/api/credential-request"
import { useLanguage } from "@/platform/i18n/provider"

const SOURCES: readonly AccountSource[] = ["own", "team"]

const SOURCE_KEY: Record<AccountSource, string> = {
  own: "settings.providers.accountSource.own",
  team: "settings.providers.accountSource.team",
}

/**
 * The hosted plane's per-provider choice between the person's own key and the
 * organization's team account, for one harness.
 */
export function useHostedAccountSources(input: {
  harness: () => string
  enabled: () => boolean
  /** Runs after a choice is stored: the catalog's connected set follows the account spent. */
  onChanged: () => Promise<void>
}) {
  const language = useLanguage()
  const client = useQueryClient()
  const queryKey = () => ["hosted-account-sources", getClaxedoServerUrl(), input.harness()] as const
  const query = useQuery(() => ({
    queryKey: queryKey(),
    queryFn: () => getHostedAccountSources({ serverUrl: getClaxedoServerUrl(), harness: input.harness(), request: authFetch }),
    enabled: input.enabled(),
  }))
  const [writing, setWriting] = createSignal<string>()

  const choose = async (providerId: string, source: AccountSource) => {
    setWriting(providerId)
    try {
      await putHostedAccountSource({
        serverUrl: getClaxedoServerUrl(),
        providerId,
        harness: input.harness(),
        source,
        request: authFetch,
      })
      await client.invalidateQueries({ queryKey: queryKey() })
      await input.onChanged()
    } catch (err: unknown) {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setWriting(undefined)
    }
  }

  return {
    enabled: input.enabled,
    error: () => (query.error instanceof Error ? query.error.message : undefined),
    source: (providerId: string): AccountSource => query.data?.sources.get(providerId) ?? "own",
    teamHeld: (providerId: string) => query.data?.team.has(providerId) === true,
    writing,
    choose,
  }
}

export type HostedAccountSources = ReturnType<typeof useHostedAccountSources>

/**
 * Drawn only where there is something to choose or something wrong: a
 * provider the organization holds a team account for, or one the person set to
 * team while none exists. Everywhere else the person's own key is the only
 * account there is.
 */
export const HostedAccountSourceChoice: Component<{
  providerId: string
  providerName: string
  sources: HostedAccountSources
}> = (props) => {
  const language = useLanguage()
  const source = () => props.sources.source(props.providerId)
  const held = () => props.sources.teamHeld(props.providerId)

  return (
    <Show when={props.sources.enabled() && (held() || source() === "team")}>
      <div
        class="flex flex-col items-start gap-1.5 pb-3 pl-8"
        data-component="account-source"
        data-source={source()}
      >
        <RadioGroup
          size="small"
          options={[...SOURCES]}
          current={source()}
          label={(option) => language.t(SOURCE_KEY[option])}
          aria-label={language.t("settings.providers.accountSource.label", { name: props.providerName })}
          disabled={props.sources.writing() !== undefined}
          onSelect={(option) => {
            if (option && option !== source()) void props.sources.choose(props.providerId, option)
          }}
        />
        <Show when={source() === "team" && !held()}>
          <p class="text-12-regular text-text-weak" role="alert" data-component="account-source-unavailable">
            {language.t("settings.providers.accountSource.unavailable", { name: props.providerName })}
          </p>
        </Show>
      </div>
    </Show>
  )
}
