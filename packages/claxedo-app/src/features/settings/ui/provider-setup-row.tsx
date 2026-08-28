import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { createSignal, Show, type Component } from "solid-js"
import { ProviderConnectForm } from "@/app/dialogs/provider-connect-form"
import { useLanguage } from "@/platform/i18n/provider"

export type ProviderSetupStatus = "connected" | "detected" | "broken" | "missing"

export function providerSetupStatusLabel(status: ProviderSetupStatus, language: ReturnType<typeof useLanguage>) {
  if (status === "connected") return language.t("settings.providers.status.connected")
  if (status === "detected") return language.t("settings.providers.status.detected")
  if (status === "broken") return language.t("settings.providers.status.broken")
  return language.t("settings.providers.status.notConnected")
}

export const ProviderSetupRow: Component<{
  id: string
  name: string
  status: ProviderSetupStatus
  detail?: string
  providerId: string
  harness?: string
  note?: string
  onConnected?: () => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)
  const connected = () => props.status === "connected"
  const showStatus = () => props.status !== "missing"

  return (
    <div class="border-b border-border-weak-base last:border-none">
      <button
        type="button"
        class="flex w-full flex-wrap items-center justify-between gap-4 py-3 text-left"
        onClick={() => {
          if (connected()) return
          setExpanded((value) => !value)
        }}
      >
        <div class="flex min-w-0 items-center gap-3">
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{props.name}</span>
            <Show when={props.note}>
              {(note) => <span class="text-12-regular text-text-weak">{note()}</span>}
            </Show>
            <Show when={props.detail && !expanded()}>
              {(detail) => <span class="text-12-regular text-text-weak">{detail()}</span>}
            </Show>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={showStatus()}>
            <Tag>{providerSetupStatusLabel(props.status, language)}</Tag>
          </Show>
          <Show when={!connected()}>
            <Button
              size="large"
              variant="ghost"
              onClick={(event: MouseEvent) => {
                event.stopPropagation()
                setExpanded((value) => !value)
              }}
            >
              {expanded() ? language.t("common.cancel") : language.t("common.connect")}
            </Button>
          </Show>
        </div>
      </button>
      <Show when={expanded() && !connected()}>
        <div class="border-t border-border-weak-base pb-4 pt-4">
          <ProviderConnectForm
            provider={props.providerId}
            harness={props.harness}
            hideHeading
            onConnected={props.onConnected}
            onDone={() => setExpanded(false)}
          />
        </div>
      </Show>
    </div>
  )
}
