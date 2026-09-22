import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Suspense, type Component } from "solid-js"
import { ProviderConnectForm } from "@/features/settings/app-ports"
import { useLanguage } from "@/platform/i18n/provider"
import {
  connectContextKey,
  connectSubject,
  connectVars,
  CONNECT_CONTEXT_COPY,
  type ConnectContext,
} from "@/platform/identity/harness-catalog"

/**
 * The connect form, with the name of what is being connected above it.
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
  const subject = () => connectSubject(props.context)
  const vars = () => connectVars(props.context)
  const title = () => props.credentialId
    ? language.t("settings.providers.connect.reconnectTitle", { provider: subject() })
    : language.t(connectContextKey(CONNECT_CONTEXT_COPY.title, props.context), vars())
  const subtitle = () => props.credentialId
    ? language.t("settings.providers.connect.reconnectSubtitle")
    : language.t("settings.providers.connect.subtitle", { provider: subject() })

  return (
    // No surface of its own. This is the dialog's body, and a bordered,
    // tinted box inside the dialog's own frame reads as two stacked cards.
    <div
      class="flex min-h-0 flex-col"
      data-component="provider-connect-card"
      data-credential={props.credentialId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        props.onClose()
      }}
    >
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-border-weak-base py-3 pl-4 pr-3">
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
      {/*
        Opened at the top. The dialog focuses the first field on open and the
        browser scrolls it into view, which landed the reader halfway down —
        past the login methods they are there to choose between.
      */}
      <div
        class="min-h-0 flex-1 overflow-y-auto p-4"
        ref={(element) => requestAnimationFrame(() => { element.scrollTop = 0 })}
      >
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
            onConnected={props.onConnected}
            onDone={() => props.onClose()}
          />
        </Suspense>
      </div>
    </div>
  )
}
