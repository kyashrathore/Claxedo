import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { createSignal, Show, type Component } from "solid-js"
import { ProviderConnectForm } from "@/features/settings/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import type { ProviderSetupStatus } from "@/features/settings/provider-settings-logic"

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
  /** The harness whose credentials this row connects. */
  harness: string
  /** The workspace-or-directory scope those credentials belong to. */
  scope?: string
  note?: string
  /** Saves the login a scan found on this machine; offered while the row reads detected. */
  onUseLogin?: () => void | Promise<void>
  onConnected?: () => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)
  const [usingLogin, setUsingLogin] = createSignal(false)
  const connected = () => props.status === "connected"
  const showStatus = () => props.status !== "missing"
  const toggle = () => setExpanded((value) => !value)
  const useLogin = async () => {
    setUsingLogin(true)
    try {
      await props.onUseLogin?.()
    } finally {
      setUsingLogin(false)
    }
  }

  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={props.id}>
      <div class="flex w-full flex-wrap items-center justify-between gap-4 py-3">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
          disabled={connected()}
          onClick={() => {
            if (connected()) return
            toggle()
          }}
        >
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{props.name}</span>
            <Show when={props.note}>
              {(note) => <span class="text-12-regular text-text-weak">{note()}</span>}
            </Show>
            <Show when={!expanded() && props.detail}>
              {(detail) => <span class="text-12-regular text-text-weak">{detail()}</span>}
            </Show>
          </div>
        </button>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={showStatus()}>
            <Tag>{providerSetupStatusLabel(props.status, language)}</Tag>
          </Show>
          <Show when={!connected() && props.status === "detected" && props.onUseLogin}>
            <Button size="large" variant="primary" disabled={usingLogin()} data-action="settings-provider-use-login" onClick={() => void useLogin()}>
              {language.t("settings.providers.agents.useLogin")}
            </Button>
          </Show>
          <Show when={!connected() && !expanded()}>
            <Button size="large" variant="ghost" onClick={toggle}>
              {language.t("common.connect")}
            </Button>
          </Show>
          <Show when={expanded()}>
            <span class="text-12-regular text-text-interactive-base">{language.t("settings.providers.connect.open")}</span>
          </Show>
        </div>
      </div>
      <Show when={expanded() && !connected()}>
        <div
          class="mb-3 ml-8 overflow-hidden rounded-md border border-border-weak-base bg-background-stronger"
          data-component="provider-connect-card"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            event.preventDefault()
            setExpanded(false)
          }}
        >
          <div class="flex items-start justify-between gap-3 border-b border-border-weak-base py-3 pl-4 pr-3">
            <div class="flex flex-col gap-0.5">
              <span class="text-14-medium text-text-strong">{language.t("settings.providers.connect.title", { provider: props.name })}</span>
              <span class="text-12-regular text-text-weak">{language.t("settings.providers.connect.subtitle", { provider: props.name })}</span>
            </div>
            <IconButton icon="close" variant="ghost" aria-label={language.t("common.close")} data-action="provider-connect-close" onClick={() => setExpanded(false)} />
          </div>
          <div class="p-4">
            <ProviderConnectForm
              provider={props.providerId}
              harness={props.harness}
              workspaceScope={props.scope}
              hideHeading
              methodPicker="segmented"
              onConnected={props.onConnected}
              onDone={() => setExpanded(false)}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
