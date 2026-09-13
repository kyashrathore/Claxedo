import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Suspense, type Component } from "solid-js"
import { ProviderConnectForm } from "@/features/settings/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import type { ConnectContext } from "@/platform/identity/harness-catalog"

/**
 * The connect form, inset in the row that opened it.
 *
 * `credentialId` switches it to replacing one account's token rather than
 * storing another account: the row keeps its id, its position and its place in
 * the accounts list, so the harness does not silently move onto a new row.
 */
export const ProviderConnectCard: Component<{
  provider: string
  /** What is being connected, in the words the card shows. */
  context: ConnectContext
  harness: string
  scope?: string
  credentialId?: string
  onConnected?: () => void | Promise<void>
  onClose: () => void
}> = (props) => {
  const language = useLanguage()
  const subject = () => props.context.kind === "harness" ? props.context.harness : props.context.vendor
  const vars = (): Record<string, string> => props.context.kind === "harness"
    ? { harness: props.context.harness, vendor: props.context.vendor }
    : { engine: props.context.engine, vendor: props.context.vendor }
  const title = () => props.credentialId
    ? language.t("settings.providers.connect.reconnectTitle", { provider: subject() })
    : language.t(`provider.connect.title.${props.context.kind}`, vars())
  const subtitle = () => props.credentialId
    ? language.t("settings.providers.connect.reconnectSubtitle")
    : language.t("settings.providers.connect.subtitle", { provider: subject() })

  return (
    <div
      class="mb-3 ml-8 overflow-hidden rounded-md border border-border-weak-base bg-background-stronger"
      data-component="provider-connect-card"
      data-credential={props.credentialId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        props.onClose()
      }}
    >
      <div class="flex items-start justify-between gap-3 border-b border-border-weak-base py-3 pl-4 pr-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-14-medium text-text-strong">{title()}</span>
          <span class="text-12-regular text-text-weak">{subtitle()}</span>
        </div>
        <IconButton
          icon="close"
          variant="ghost"
          aria-label={language.t("common.close")}
          data-action="provider-connect-close"
          onClick={() => props.onClose()}
        />
      </div>
      <div class="p-4">
        {/*
          The form is loaded on demand, and `lazy` suspends the nearest boundary
          while its chunk arrives. Without one here that is the app shell, so
          opening this card swapped the whole window for the boot fallback and
          read as a page reload.
        */}
        <Suspense fallback={<div class="h-24" data-component="provider-connect-loading" />}>
          <ProviderConnectForm
            provider={props.provider}
            context={props.context}
            harness={props.harness}
            workspaceScope={props.scope}
            credentialId={props.credentialId}
            hideHeading
            methodPicker="segmented"
            onConnected={props.onConnected}
            onDone={() => props.onClose()}
          />
        </Suspense>
      </div>
    </div>
  )
}
