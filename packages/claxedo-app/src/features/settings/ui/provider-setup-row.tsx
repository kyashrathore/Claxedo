import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { createSignal, Show, type Component } from "solid-js"
import { ProviderConnectCard } from "@/features/settings/ui/provider-connect-card"
import { useLanguage } from "@/platform/i18n/provider"

/** A provider a harness has no credential for, with Connect opening an inset card. */
export const ProviderSetupRow: Component<{
  id: string
  name: string
  providerId: string
  /** The harness whose credentials this row connects. */
  harness: string
  /** The workspace-or-directory scope those credentials belong to. */
  scope?: string
  note?: string
  onConnected?: () => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={props.id}>
      <div class="flex w-full flex-wrap items-start justify-between gap-4 py-3">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-start gap-3 border-none bg-transparent p-0 text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{props.name}</span>
            <Show when={props.note}>
              {(note) => <span class="text-12-regular text-text-weak">{note()}</span>}
            </Show>
          </div>
        </button>
        <div class="flex shrink-0 items-center gap-2" data-component="provider-actions">
          <Show
            when={expanded()}
            fallback={(
              <Button size="large" variant="ghost" onClick={() => setExpanded(true)}>
                {language.t("common.connect")}
              </Button>
            )}
          >
            <span class="text-12-regular text-text-interactive-base">{language.t("settings.providers.connect.open")}</span>
          </Show>
        </div>
      </div>
      <Show when={expanded()}>
        <ProviderConnectCard
          provider={props.providerId}
          providerName={props.name}
          harness={props.harness}
          scope={props.scope}
          onConnected={props.onConnected}
          onClose={() => setExpanded(false)}
        />
      </Show>
    </div>
  )
}
